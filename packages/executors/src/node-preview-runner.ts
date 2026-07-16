import { execa } from 'execa';
import { connect } from 'node:net';
import type { PreviewHealth, PreviewProcess, PreviewSession } from '@agent-foundry/contracts';
import {
  isPreviewSessionTerminal,
  recordPreviewCommandPlan,
  stopPreviewSession,
  transitionPreviewSession,
  SystemClock,
  type Clock,
  type PreviewRunner,
} from '@agent-foundry/domain';
import { resolvePreviewCommandPlan, runReproducibleInstall } from './preview-command-plan.js';
import { detectPortFromOutput, reservePreviewPort } from './preview-port.js';

export interface NodePreviewRunnerOptions {
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  maxOutputBytes?: number;
  clock?: Clock;
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
  logs: string[];
  exited: boolean;
}

// Keeps the combined worst case (this spawn-confirm poll + PreviewService's own
// health poll, each ~5s) near the documented ~10s startup window instead of
// doubling it when a dev server hangs without ever crashing.
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const DEFAULT_LOG_BUFFER_LINES = 500;
const POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 5_000_000;

/**
 * Mechanism-only PreviewRunner: reserves/detects a port, spawns the dev
 * command, and does a single TCP-connect health probe. Configurable startup
 * windows, HTTP-level health, crash/restart policy, and log
 * cursor/redaction are v05-preview-lifecycle's job, not this one's.
 */
export class NodePreviewRunner implements PreviewRunner {
  private readonly reservePort: () => Promise<number>;
  private readonly startupTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly clock: Clock;
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(options: NodePreviewRunnerOptions = {}) {
    this.reservePort = options.reservePort ?? reservePreviewPort;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.clock = options.clock ?? new SystemClock();
  }

  async prepare(session: PreviewSession): Promise<PreviewSession> {
    const plan = await resolvePreviewCommandPlan(session.workspaceRef.workspacePath);
    const withPlan = recordPreviewCommandPlan(session, plan, this.clock.now());
    if (!plan.install.ok) return withPlan; // no install needed/possible; start() will fail fast on a bad dev command
    const outcome = await runReproducibleInstall(plan, session.workspaceRef.workspacePath, {
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
      maxOutputBytes: this.maxOutputBytes,
    });
    if (outcome.ok) return withPlan;
    return transitionPreviewSession(withPlan, 'failed', this.clock.now(), {
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
    await this.killTracked(session.id);
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
    const reachable = await tcpProbe(entry.port);
    return {
      state: reachable ? 'healthy' : 'unhealthy',
      checkedAt: now,
      consecutiveFailures: reachable ? 0 : 1,
    };
  }

  async logs(session: PreviewSession, options: { tailLines?: number } = {}): Promise<string> {
    const entry = this.processes.get(session.id);
    if (!entry) return '';
    const lines = options.tailLines ? entry.logs.slice(-options.tailLines) : entry.logs;
    return lines.join('\n');
  }

  async stop(session: PreviewSession): Promise<PreviewSession> {
    if (isPreviewSessionTerminal(session.status)) return session;
    await this.killTracked(session.id);
    return stopPreviewSession(session, this.clock.now());
  }

  private async killTracked(sessionId: string): Promise<void> {
    const entry = this.processes.get(sessionId);
    if (!entry) return;
    if (!entry.exited) {
      entry.child.kill('SIGTERM');
      await Promise.race([
        Promise.resolve(entry.child).catch(() => undefined),
        new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
      ]);
    }
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
    if (attempt.crashedImmediately) attempt = await this.attemptSpawn(session, dev); // single retry on bind conflict
    if (attempt.crashedImmediately) {
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
    }) as unknown as DevServerProcess;
    const entry: ProcessEntry = { child, port: reservedPort, logs: [], exited: false };
    this.processes.set(session.id, entry);
    void child.then(() => {
      entry.exited = true;
    });
    let detectedPort: number | undefined;
    const captureAndDetect = (data: Buffer): void => {
      const text = data.toString('utf8');
      appendLog(entry, DEFAULT_LOG_BUFFER_LINES, text);
      detectedPort ??= detectPortFromOutput(text);
    };
    child.stdout?.on('data', captureAndDetect);
    child.stderr?.on('data', captureAndDetect);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) return { port: reservedPort, pid: undefined, crashedImmediately: true };
      const candidate = detectedPort ?? reservedPort;
      if (await tcpProbe(candidate)) {
        entry.port = candidate;
        return { port: candidate, pid: child.pid, crashedImmediately: false };
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, POLL_INTERVAL_MS));
    }
    return { port: detectedPort ?? reservedPort, pid: child.pid, crashedImmediately: entry.exited };
  }
}

function appendLog(entry: ProcessEntry, maxLines: number, text: string): void {
  for (const line of text.split('\n')) {
    if (!line) continue;
    entry.logs.push(line);
  }
  if (entry.logs.length > maxLines) entry.logs.splice(0, entry.logs.length - maxLines);
}

async function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host: '127.0.0.1', timeout: 500 });
    socket.once('connect', () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once('error', () => resolvePromise(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolvePromise(false);
    });
  });
}
