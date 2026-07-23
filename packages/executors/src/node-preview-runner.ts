import { execa } from 'execa';
import { get } from 'node:http';
import type {
  PreviewHealth,
  PreviewLogEntry,
  PreviewLogPage,
  PreviewProcess,
  PreviewSession,
} from '@agent-foundry/contracts';
import {
  isPreviewSessionTerminal,
  recordPreviewCommandPlan,
  stopPreviewSession,
  transitionPreviewSession,
  SystemClock,
  type Clock,
  type PreviewLogRepository,
  type PreviewRunner,
} from '@agent-foundry/domain';
import {
  resolvePreviewCommandPlan,
  runReproducibleInstall,
  type PreviewInstaller,
} from './preview-command-plan.js';
import { detectPortFromOutput, reservePreviewPort } from './preview-port.js';
import {
  killProcessTree,
  terminatePersistedProcessTree,
  terminateProcessTree,
} from './process-tree.js';

export interface NodePreviewRunnerOptions {
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  maxOutputBytes?: number;
  clock?: Clock;
  healthPath?: string;
  logRepository?: PreviewLogRepository;
  installer?: PreviewInstaller;
}

// execa's ResultPromise<Options> return type varies per call site's options
// and doesn't play well with exactOptionalPropertyTypes across a plain field
// assignment; narrowed to exactly the members this runner touches, same
// pattern as base-cli-executor.ts's CliSubprocess.
interface DevServerProcess extends PromiseLike<unknown> {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  stdout?: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
}

interface ProcessEntry {
  child: DevServerProcess;
  port: number;
  logWrites: Promise<void>;
  exited: boolean;
}

// Half of PreviewService's own health-poll timeout, so the combined worst case
// (this spawn-confirm poll + PreviewService's health poll) stays around 15s
// instead of doubling to ~20s when a dev server hangs without ever crashing.
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 5_000_000;

/**
 * Mechanism-only PreviewRunner: reserves/detects a port, spawns the dev
 * command, persists structured output, probes HTTP readiness, and terminates
 * the complete process tree. Restart policy remains an orchestrator concern.
 */
export class NodePreviewRunner implements PreviewRunner {
  private readonly reservePort: () => Promise<number>;
  private readonly startupTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly clock: Clock;
  private readonly healthPath: string;
  private readonly logRepository: PreviewLogRepository | undefined;
  private readonly installer: PreviewInstaller | undefined;
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(options: NodePreviewRunnerOptions = {}) {
    this.reservePort = options.reservePort ?? reservePreviewPort;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.clock = options.clock ?? new SystemClock();
    this.healthPath = options.healthPath ?? '/';
    this.logRepository = options.logRepository;
    this.installer = options.installer;
  }

  async prepare(session: PreviewSession): Promise<PreviewSession> {
    const plan = await resolvePreviewCommandPlan(session.workspaceRef.workspacePath);
    const withPlan = recordPreviewCommandPlan(session, plan, this.clock.now());
    if (!plan.install.ok) return withPlan; // no install needed/possible; start() will fail fast on a bad dev command
    const outcome = this.installer
      ? await this.installer.install({
          plan,
          workspacePath: session.workspaceRef.workspacePath,
        })
      : await runReproducibleInstall(plan, session.workspaceRef.workspacePath, {
          timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
          maxOutputBytes: this.maxOutputBytes,
        });
    const withEvidence = recordPreviewCommandPlan(
      session,
      {
        ...plan,
        ...(outcome.versions ? { versions: outcome.versions } : {}),
        ...(outcome.networkEvents ? { installNetworkEvents: outcome.networkEvents } : {}),
      },
      this.clock.now(),
    );
    if (outcome.ok) return withEvidence;
    return transitionPreviewSession(withEvidence, 'failed', this.clock.now(), {
      error: {
        name: 'PreviewInstallError',
        code: 'PREVIEW_INSTALL_FAILED',
        message: outcome.stderr || 'Install failed.',
      },
    });
  }

  async start(session: PreviewSession): Promise<PreviewSession> {
    return this.spawn(session);
  }

  async restart(session: PreviewSession): Promise<PreviewSession> {
    await this.killTracked(session.id, session.process?.pid);
    return this.spawn(session);
  }

  async health(session: PreviewSession): Promise<PreviewHealth> {
    const entry = this.processes.get(session.id);
    const now = this.clock.now().toISOString();
    if (!entry || entry.exited) {
      return {
        state: 'unhealthy',
        checkedAt: now,
        consecutiveFailures: 1,
        detail: 'process not running',
      };
    }
    const reachable = await httpProbe(entry.port, this.healthPath);
    return {
      state: reachable ? 'healthy' : 'unhealthy',
      checkedAt: now,
      consecutiveFailures: reachable ? 0 : 1,
    };
  }

  async logs(
    session: PreviewSession,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<PreviewLogPage> {
    const entry = this.processes.get(session.id);
    await entry?.logWrites;
    return this.logRepository?.list(session.id, options) ?? { entries: [], nextCursor: 0 };
  }

  async stop(session: PreviewSession): Promise<PreviewSession> {
    await this.killTracked(session.id, session.process?.pid);
    if (isPreviewSessionTerminal(session.status)) return session;
    return stopPreviewSession(session, this.clock.now());
  }

  private async killTracked(sessionId: string, persistedPid?: number): Promise<void> {
    const entry = this.processes.get(sessionId);
    if (!entry) {
      if (persistedPid !== undefined) await terminatePersistedProcessTree(persistedPid);
      return;
    }
    if (entry.exited) killProcessTree(entry.child, 'SIGKILL');
    else await terminateProcessTree(entry.child);
    await entry.logWrites;
    this.processes.delete(sessionId);
  }

  private async spawn(session: PreviewSession): Promise<PreviewSession> {
    const dev = session.commandPlan?.dev;
    if (!dev?.ok) {
      return transitionPreviewSession(session, 'failed', this.clock.now(), {
        error: {
          name: 'PreviewCommandError',
          code: 'PREVIEW_NO_DEV_COMMAND',
          message: dev?.reason ?? 'No dev command resolved.',
        },
      });
    }
    let attempt = await this.attemptSpawn(session, dev);
    if (attempt.crashedImmediately) {
      await this.killTracked(session.id);
      attempt = await this.attemptSpawn(session, dev); // single retry on bind conflict
    }
    if (attempt.crashedImmediately) {
      await this.killTracked(session.id);
      return transitionPreviewSession(session, 'failed', this.clock.now(), {
        error: {
          name: 'PreviewStartError',
          code: 'PREVIEW_START_FAILED',
          message: 'Dev server exited immediately twice.',
        },
      });
    }
    const process: PreviewProcess = {
      command: dev.command,
      args: dev.args,
      pid: attempt.pid,
      port: attempt.port,
    };
    return transitionPreviewSession(session, 'starting', this.clock.now(), { process });
  }

  private async attemptSpawn(
    session: PreviewSession,
    dev: { command: string; args: string[] },
  ): Promise<{ port: number; pid: number | undefined; crashedImmediately: boolean }> {
    const reservedPort = await this.reservePort();
    const child = execa(dev.command, dev.args, {
      cwd: session.workspaceRef.workspacePath,
      env: { ...process.env, PORT: String(reservedPort), HOST: '127.0.0.1' },
      reject: false,
      detached: process.platform !== 'win32',
    }) as unknown as DevServerProcess;
    const entry: ProcessEntry = {
      child,
      port: reservedPort,
      logWrites: Promise.resolve(),
      exited: false,
    };
    this.processes.set(session.id, entry);
    const markExited = (): void => {
      entry.exited = true;
    };
    void child.then(markExited, markExited);
    let detectedPort: number | undefined;
    const capture =
      (stream: PreviewLogEntry['stream']) =>
      (data: Buffer): void => {
        const text = data.toString('utf8');
        const port = detectPortFromOutput(text);
        if (port !== undefined) {
          detectedPort = port;
          entry.port = port;
        }
        const repository = this.logRepository;
        if (!repository) return;
        const timestamp = this.clock.now().toISOString();
        const lines = text.split('\n').filter(Boolean);
        entry.logWrites = entry.logWrites.then(async () => {
          for (const message of lines) {
            try {
              await repository.append(session.id, { stream, message, timestamp });
            } catch {
              // The repository is the redaction boundary; drop failed raw output instead of buffering it.
            }
          }
        });
      };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) return { port: reservedPort, pid: undefined, crashedImmediately: true };
      const candidate = detectedPort ?? reservedPort;
      if (await httpProbe(candidate, this.healthPath)) {
        entry.port = candidate;
        return { port: candidate, pid: child.pid, crashedImmediately: false };
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, POLL_INTERVAL_MS));
    }
    return { port: detectedPort ?? reservedPort, pid: child.pid, crashedImmediately: entry.exited };
  }
}

async function httpProbe(port: number, path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const request = get({ port, host: '127.0.0.1', path }, (response) => {
      const healthy =
        response.statusCode !== undefined &&
        response.statusCode >= 200 &&
        response.statusCode < 300;
      response.destroy();
      resolvePromise(healthy);
    });
    request.once('error', () => resolvePromise(false));
    request.setTimeout(500, () => {
      request.destroy();
    });
  });
}
