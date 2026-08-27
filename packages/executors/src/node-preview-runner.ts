import { execa } from 'execa';
import { get } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import {
  PREVIEW_INFRASTRUCTURE_ERROR_CODE,
  PREVIEW_INFRASTRUCTURE_ERROR_NAME,
} from '@agent-foundry/contracts';
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
  tailBytes,
  transitionPreviewSession,
  SystemClock,
  type Clock,
  type PreviewLogRepository,
  type PreviewRunner,
  type SecretStore,
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
import { safeSpawnEnv } from './safe-environment.js';

export interface NodePreviewRunnerOptions {
  reservePort?: () => Promise<number>;
  startupTimeoutMs?: number;
  maxOutputBytes?: number;
  clock?: Clock;
  healthPath?: string;
  logRepository?: PreviewLogRepository;
  installer?: PreviewInstaller;
  secretStore?: Pick<SecretStore, 'resolveAll'>;
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
  /**
   * This runner asked the process to die. Set before the kill, so the exit
   * handler can tell a deliberate stop from a signal that came from outside
   * (an OOM kill, an operator's `kill -9`) — which is a cause worth reporting,
   * and whose only carrier is that line (#663).
   */
  stopping: boolean;
  exitCode?: number;
  output: { stdout: string; stderr: string };
  flushOutput: () => void;
}

// Half of PreviewService's own health-poll timeout, so the combined worst case
// (this spawn-confirm poll + PreviewService's health poll) stays around 15s
// instead of doubling to ~20s when a dev server hangs without ever crashing.
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 100;
const DEFAULT_MAX_OUTPUT_BYTES = 5_000_000;
// Separate from maxOutputBytes/DEFAULT_MAX_OUTPUT_BYTES on purpose: those bound
// execa's maxBuffer and the in-memory stdout/stderr capture accumulator (needs
// to stay large -- a real `pnpm install` easily exceeds 1MB of output). This
// constant instead bounds every field that ends up in a session's persisted
// failureEvidence (install-failure, spawn-failure, and stop()'s runtime-crash
// paths), matching PreviewService's own DIAGNOSTIC_MAX_OUTPUT_BYTES so evidence
// never balloons to the multi-MB capture budget. Do not collapse these two
// constants back into one -- that's what let runtime crash evidence in stop()
// go out at up to the full capture budget (#346).
const EVIDENCE_MAX_OUTPUT_BYTES = 1_000_000;

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
  private readonly secretStore: Pick<SecretStore, 'resolveAll'> | undefined;
  private readonly processes = new Map<string, ProcessEntry>();

  constructor(options: NodePreviewRunnerOptions = {}) {
    this.reservePort = options.reservePort ?? reservePreviewPort;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.clock = options.clock ?? new SystemClock();
    this.healthPath = options.healthPath ?? '/';
    this.logRepository = options.logRepository;
    this.installer = options.installer;
    this.secretStore = options.secretStore;
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
      },
      this.clock.now(),
    );
    if (outcome.ok) return withEvidence;
    const stderrTail = tailBytes(outcome.stderr, EVIDENCE_MAX_OUTPUT_BYTES);
    return transitionPreviewSession(withEvidence, 'failed', this.clock.now(), {
      // An install the environment prevented and an install the generated
      // app's own dependencies broke are the same failure from here; the
      // installer is the only layer that knows which, so it says so and this
      // carries the distinction into the session's identity (#659).
      error: outcome.infrastructure
        ? {
            name: PREVIEW_INFRASTRUCTURE_ERROR_NAME,
            code: PREVIEW_INFRASTRUCTURE_ERROR_CODE,
            message: stderrTail || 'Preview install could not run.',
          }
        : {
            name: 'PreviewInstallError',
            code: 'PREVIEW_INSTALL_FAILED',
            message: stderrTail || 'Install failed.',
          },
      failureEvidence: {
        command: plan.install.ok
          ? { command: plan.install.command, args: plan.install.args }
          : undefined,
        exitCode: outcome.exitCode,
        stdout: tailBytes(outcome.stdout, EVIDENCE_MAX_OUTPUT_BYTES),
        stderr: stderrTail,
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
      // No local entry ≠ dead: a session booted by another process on this
      // host (worker-booted, API-reaped) is only reachable through its
      // persisted port. Probe it before declaring the preview down.
      const persistedPort = entry ? undefined : session.process?.port;
      if (persistedPort !== undefined && (await httpProbe(persistedPort, this.healthPath))) {
        return { state: 'healthy', checkedAt: now, consecutiveFailures: 0 };
      }
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
    // entry is a reference into this.processes, not a value snapshot: for a
    // still-running process, killTracked (below) awaits terminateProcessTree,
    // which waits on this same entry's child-exit promise -- so by the time
    // the await resolves, entry.exited has already flipped true even though
    // the kill was intentional, not a crash. Snapshot the boolean itself
    // *before* the await; entry.exitCode/.output are still safe to read
    // after it once hadExited was already true, since a process that has
    // already exited emits no further output and its exit code is fixed.
    const entry = this.processes.get(session.id);
    const hadExited = entry?.exited ?? false;
    await this.killTracked(session.id, session.process?.pid);
    if (isPreviewSessionTerminal(session.status)) return session;
    const withEvidence =
      hadExited && entry && !session.failureEvidence
        ? {
            ...session,
            failureEvidence: {
              ...(session.process
                ? { command: { command: session.process.command, args: session.process.args } }
                : {}),
              ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
              // entry.output is bounded by maxOutputBytes (the capture budget,
              // can be much larger); trim to the evidence budget on the way
              // into persisted failureEvidence.
              stdout: tailBytes(entry.output.stdout, EVIDENCE_MAX_OUTPUT_BYTES),
              stderr: tailBytes(entry.output.stderr, EVIDENCE_MAX_OUTPUT_BYTES),
            },
          }
        : session;
    return stopPreviewSession(withEvidence, this.clock.now());
  }

  private async killTracked(sessionId: string, persistedPid?: number): Promise<void> {
    const entry = this.processes.get(sessionId);
    if (!entry) {
      if (persistedPid !== undefined) await terminatePersistedProcessTree(persistedPid);
      return;
    }
    entry.stopping = true;
    if (entry.exited) killProcessTree(entry.child, 'SIGKILL');
    else await terminateProcessTree(entry.child);
    entry.flushOutput();
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
        failureEvidence: {
          exitCode: 1,
          stdout: '',
          stderr: dev?.reason ?? 'No dev command resolved.',
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
      // A dev server that ran and exited reports an exit code: the generated
      // app crashed, which is a product defect. No exit code at all means the
      // command never became a process — the package manager is missing from
      // this host — and that is the environment's fault, not the app's (#659).
      const neverStarted = attempt.exitCode === undefined;
      return transitionPreviewSession(session, 'failed', this.clock.now(), {
        error: neverStarted
          ? {
              name: PREVIEW_INFRASTRUCTURE_ERROR_NAME,
              code: PREVIEW_INFRASTRUCTURE_ERROR_CODE,
              message: 'Dev server never started twice.',
            }
          : {
              name: 'PreviewStartError',
              code: 'PREVIEW_START_FAILED',
              message: 'Dev server exited immediately twice.',
            },
        failureEvidence: {
          command: { command: dev.command, args: dev.args },
          ...(attempt.exitCode !== undefined ? { exitCode: attempt.exitCode } : {}),
          stdout: tailBytes(attempt.stdout, EVIDENCE_MAX_OUTPUT_BYTES),
          stderr: tailBytes(attempt.stderr, EVIDENCE_MAX_OUTPUT_BYTES),
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
  ): Promise<{
    port: number;
    pid: number | undefined;
    crashedImmediately: boolean;
    exitCode?: number;
    stdout: string;
    stderr: string;
  }> {
    const reservedPort = await this.reservePort();
    // The scaffold's api tier reads API_PORT (the single PORT belongs to the
    // browsable tier); without its own reservation, concurrent projects would
    // all bind the api tier's default port and kill each other's `pnpm dev`.
    // Reservation releases the port before returning, so the OS can hand the
    // same one back — retry until the two tiers get distinct ports.
    let apiPort = reservedPort;
    for (let attempt = 0; attempt < 10 && apiPort === reservedPort; attempt += 1) {
      apiPort = await this.reservePort();
    }
    const secrets = this.secretStore
      ? await this.secretStore.resolveAll(session.workspaceRef.projectId)
      : {};
    const child = execa(dev.command, dev.args, {
      cwd: session.workspaceRef.workspacePath,
      ...safeSpawnEnv(process.env, {
        ...secrets,
        PORT: String(reservedPort),
        API_PORT: String(apiPort),
        HOST: '127.0.0.1',
      }),
      reject: false,
      detached: process.platform !== 'win32',
    }) as unknown as DevServerProcess;
    const entry: ProcessEntry = {
      child,
      port: reservedPort,
      logWrites: Promise.resolve(),
      exited: false,
      stopping: false,
      output: { stdout: '', stderr: '' },
      flushOutput: () => {},
    };
    this.processes.set(session.id, entry);
    let detectedPort: number | undefined;
    const decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const appendOutput = (stream: PreviewLogEntry['stream'], text: string): void => {
      if (!text) return;
      // ponytail: re-encodes the whole retained buffer on every chunk; the
      // existing capture budget is the deliberate ceiling. Upgrade path is a
      // raw-buffer ring if this becomes hot for long-lived chatty servers.
      entry.output[stream] = tailBytes(`${entry.output[stream]}${text}`, this.maxOutputBytes);
      const port = detectPortFromOutput(text);
      if (port !== undefined && port !== apiPort) {
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
    entry.flushOutput = () => {
      appendOutput('stdout', decoders.stdout.end());
      appendOutput('stderr', decoders.stderr.end());
    };
    const capture =
      (stream: PreviewLogEntry['stream']) =>
      (data: Buffer): void => {
        appendOutput(stream, decoders[stream].write(data));
      };
    child.stdout?.on('data', capture('stdout'));
    child.stderr?.on('data', capture('stderr'));
    const markExited = (result: unknown): void => {
      entry.exited = true;
      if (typeof result !== 'object' || result === null) return;
      const record = result as {
        exitCode?: unknown;
        signal?: unknown;
        shortMessage?: unknown;
        message?: unknown;
      };
      if (typeof record.exitCode === 'number') {
        entry.exitCode = record.exitCode;
        return;
      }
      // A signal means the process existed and something killed it. When this
      // runner asked for that, the reason is not stderr the dev server printed
      // and must stay out of the operator's log. When it came from outside —
      // an OOM kill, an operator's `kill -9` — this line is the only carrier
      // of the cause: `PreviewFailureEvidenceSchema` is `.strict()` with no
      // field for a signal, so dropping it here loses it everywhere (#663).
      if (record.signal && entry.stopping) return;
      // What is left is a spawn that never reached the program — the package
      // manager missing from PATH (ENOENT), a non-executable entry point — and
      // it resolves here with no exit code and no output at all. Without this
      // the only evidence the preview can report is 'Dev server exited
      // immediately twice.', which names neither the command nor the reason
      // (#658).
      const reason =
        typeof record.shortMessage === 'string'
          ? record.shortMessage
          : typeof record.message === 'string'
            ? record.message
            : undefined;
      if (reason) appendOutput('stderr', reason);
    };
    void child.then(markExited, markExited);

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (entry.exited) {
        entry.flushOutput();
        return {
          port: reservedPort,
          pid: undefined,
          crashedImmediately: true,
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          ...entry.output,
        };
      }
      const candidate = detectedPort ?? reservedPort;
      if (await httpProbe(candidate, this.healthPath)) {
        entry.port = candidate;
        return { port: candidate, pid: child.pid, crashedImmediately: false, ...entry.output };
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, POLL_INTERVAL_MS));
    }
    if (entry.exited) entry.flushOutput();
    return {
      port: detectedPort ?? reservedPort,
      pid: child.pid,
      crashedImmediately: entry.exited,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...entry.output,
    };
  }
}

async function httpProbe(port: number, path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const request = get({ port, host: '127.0.0.1', path }, (response) => {
      // 3xx counts as booted: an auth-gated app answers its root with a
      // redirect to the sign-in page, which is a live server, not a failure.
      const healthy =
        response.statusCode !== undefined &&
        response.statusCode >= 200 &&
        response.statusCode < 400;
      response.destroy();
      resolvePromise(healthy);
    });
    request.once('error', () => resolvePromise(false));
    request.setTimeout(500, () => {
      request.destroy();
    });
  });
}
