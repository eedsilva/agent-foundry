import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewLogPageSchema,
  PreviewSessionSchema,
  type PreviewLogEntry,
  type PreviewLogPage,
  type PreviewSession,
} from '@agent-foundry/contracts';
import type { PreviewLogRepository } from '@agent-foundry/domain';
import { NodePreviewRunner } from './node-preview-runner.js';

const FIXTURE_DIR = resolve(import.meta.dirname, 'fixtures');
const FIXTURE_SCRIPT = resolve(FIXTURE_DIR, 'preview-dev-server.mjs');

// Workspaces live outside the repo tree (via os.tmpdir()), not under
// FIXTURE_DIR: FIXTURE_DIR sits inside this npm-workspaces monorepo, and
// detectPackageManager() walks upward looking for a lockfile. Using it
// directly as workspacePath makes prepare()'s install step escape the
// sandbox and run a real `npm ci` against the *monorepo root*, deleting and
// reinstalling node_modules mid-test-run (confirmed by direct reproduction).
const temporaryDirectories: string[] = [];
const strayPids: number[] = [];
afterEach(async () => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

class InMemoryPreviewLogRepository implements PreviewLogRepository {
  private readonly entries = new Map<string, PreviewLogEntry[]>();

  append(sessionId: string, entry: Omit<PreviewLogEntry, 'cursor'>): Promise<PreviewLogEntry> {
    const entries = this.entries.get(sessionId) ?? [];
    const persisted = { ...entry, cursor: (entries.at(-1)?.cursor ?? 0) + 1 };
    entries.push(persisted);
    this.entries.set(sessionId, entries);
    return Promise.resolve(persisted);
  }

  list(
    sessionId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<PreviewLogPage> {
    const entries = (this.entries.get(sessionId) ?? [])
      .filter((entry) => entry.cursor > (options.cursor ?? 0))
      .slice(0, options.limit ?? 200);
    return Promise.resolve(
      PreviewLogPageSchema.parse({
        entries,
        nextCursor: entries.at(-1)?.cursor ?? options.cursor ?? 0,
      }),
    );
  }
}

class RejectFirstLogRepository implements PreviewLogRepository {
  private readonly persisted = new InMemoryPreviewLogRepository();
  private rejected = false;

  append(sessionId: string, entry: Omit<PreviewLogEntry, 'cursor'>): Promise<PreviewLogEntry> {
    if (!this.rejected) {
      this.rejected = true;
      return Promise.reject(new Error('log persistence unavailable'));
    }
    return this.persisted.append(sessionId, entry);
  }

  list(sessionId: string, options?: { cursor?: number; limit?: number }): Promise<PreviewLogPage> {
    return this.persisted.list(sessionId, options);
  }
}

class BlockingTailLogRepository implements PreviewLogRepository {
  private readonly persisted = new InMemoryPreviewLogRepository();
  private releaseTail!: () => void;
  private tailStartedResolve!: () => void;
  readonly tailStarted = new Promise<void>((resolve) => {
    this.tailStartedResolve = resolve;
  });
  private readonly tailReleased = new Promise<void>((resolve) => {
    this.releaseTail = resolve;
  });

  async append(
    sessionId: string,
    entry: Omit<PreviewLogEntry, 'cursor'>,
  ): Promise<PreviewLogEntry> {
    if (entry.message === 'fixture stopping') {
      this.tailStartedResolve();
      await this.tailReleased;
    }
    return this.persisted.append(sessionId, entry);
  }

  list(sessionId: string, options?: { cursor?: number; limit?: number }): Promise<PreviewLogPage> {
    return this.persisted.list(sessionId, options);
  }

  release(): void {
    this.releaseTail();
  }
}

async function newSession(id: string): Promise<PreviewSession> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-runner-'));
  temporaryDirectories.push(workspacePath);
  const now = new Date().toISOString();
  return PreviewSessionSchema.parse({
    id,
    workspaceRef: { projectId: 'proj-1', workspacePath },
    status: 'preparing',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: 300 },
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

async function canConnect(port: number): Promise<boolean> {
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

describe('NodePreviewRunner', () => {
  it('starts the fixture dev server and reports it healthy on a distinct port', async () => {
    const runner = new NodePreviewRunner({
      startupTimeoutMs: 5_000,
      logRepository: new InMemoryPreviewLogRepository(),
    });
    let session = await newSession('sess-a');
    session = await runner.prepare(session);
    expect(session.commandPlan?.dev.ok).toBe(false); // no package.json in the empty temp workspace
    // Command plan detection only knows npm scripts; drive the fixture directly instead.
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);
    expect(session.status).toBe('starting');
    expect(session.process?.port).toBeGreaterThan(0);

    const health = await runner.health(session);
    expect(health.state).toBe('healthy');
    expect(await canConnect(session.process!.port!)).toBe(true);

    const logOutput = await runner.logs(session);
    expect(logOutput.entries.some((entry) => entry.message.includes('VITE fixture'))).toBe(true);

    // transitionPreviewSession only allows restart() from 'unhealthy' (or
    // 'preparing'), never straight from 'starting' -- fabricate a
    // schema-valid 'unhealthy' session (serving states require url,
    // startedAt, and ttl.expiresAt) to exercise the kill-then-respawn path.
    const unhealthySession = PreviewSessionSchema.parse({
      ...session,
      status: 'unhealthy',
      url: `http://127.0.0.1:${session.process!.port}/`,
      startedAt: session.updatedAt,
      ttl: { ...session.ttl, expiresAt: new Date(Date.now() + 300_000).toISOString() },
    });
    const restarted = await runner.restart(unhealthySession);
    expect(restarted.status).toBe('starting');
    expect(restarted.process?.port).toBeGreaterThan(0);
    expect(await canConnect(session.process!.port!)).toBe(false); // old process killed
    const restartedHealth = await runner.health(restarted);
    expect(restartedHealth.state).toBe('healthy');
    expect(await canConnect(restarted.process!.port!)).toBe(true);

    const stopped = await runner.stop(restarted);
    expect(stopped.status).toBe('stopped');
    expect(await canConnect(restarted.process!.port!)).toBe(false);

    const stoppedAgain = await runner.stop(stopped); // idempotent
    expect(stoppedAgain).toEqual(stopped);
  }, 15_000);

  it('requires a successful HTTP response instead of treating an open TCP port as healthy', async () => {
    const runner = new NodePreviewRunner({
      startupTimeoutMs: 250,
      healthPath: '/not-ready',
      logRepository: new InMemoryPreviewLogRepository(),
    });
    let session = await newSession('sess-http-health');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);

    expect(await canConnect(session.process!.port!)).toBe(true);
    await expect(runner.health(session)).resolves.toMatchObject({ state: 'unhealthy' });
    await runner.stop(session);
  }, 10_000);

  it('persists stdout and stderr as distinct structured log streams', async () => {
    const runner = new NodePreviewRunner({
      startupTimeoutMs: 5_000,
      logRepository: new InMemoryPreviewLogRepository(),
    });
    let session = await newSession('sess-logs');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);

    const page = await runner.logs(session);
    expect(page.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: 'stdout', message: expect.stringContaining('VITE') }),
        expect.objectContaining({ stream: 'stderr', message: 'fixture stderr' }),
      ]),
    );
    expect(page.entries.every((entry) => entry.timestamp.length > 0)).toBe(true);
    await runner.stop(session);
  }, 10_000);

  it('drops one failed log append without retaining raw output or breaking later appends', async () => {
    const repository = new RejectFirstLogRepository();
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000, logRepository: repository });
    let session = await newSession('sess-log-failure');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);
    try {
      const page = await runner.logs(session);
      expect(page.entries.length).toBeGreaterThan(0);
      expect(page.entries.some((entry) => entry.message === 'fixture stderr')).toBe(true);
      expect(page.entries.some((entry) => entry.message.includes('VITE fixture'))).toBe(false);
    } finally {
      await runner.stop(session);
    }
  }, 10_000);

  it('drains pending tail log writes before stop deletes process tracking', async () => {
    const repository = new BlockingTailLogRepository();
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000, logRepository: repository });
    let session = await newSession('sess-tail-drain');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);
    let stopped = false;
    const stop = runner.stop(session).then((result) => {
      stopped = true;
      return result;
    });

    try {
      await repository.tailStarted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(stopped).toBe(false);
    } finally {
      repository.release();
      await stop;
    }
    await expect(runner.logs(session)).resolves.toMatchObject({
      entries: expect.arrayContaining([expect.objectContaining({ message: 'fixture stopping' })]),
    });
  }, 10_000);

  it('closes a successful HTTP probe response whose body never ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'preview-http-probe-'));
    temporaryDirectories.push(directory);
    const responseCloseFile = join(directory, 'response-closed');
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000, healthPath: '/never-ending' });
    let session = await newSession('sess-http-close');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: {
          ok: true,
          command: 'node',
          args: [FIXTURE_SCRIPT, `--response-close-file=${responseCloseFile}`],
        },
      },
    };
    session = await runner.start(session);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(access(responseCloseFile)).resolves.toBeUndefined();
    } finally {
      await runner.stop(session);
    }
  }, 10_000);

  it.runIf(process.platform !== 'win32')(
    'cleans a crashed first attempt process group before the single respawn',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'preview-first-attempt-'));
      temporaryDirectories.push(directory);
      const markerFile = join(directory, 'first-exited');
      const pidFile = join(directory, 'pids');
      const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000 });
      let session = await newSession('sess-first-attempt');
      session = await runner.prepare(session);
      session = {
        ...session,
        commandPlan: {
          ...session.commandPlan!,
          dev: {
            ok: true,
            command: 'node',
            args: [FIXTURE_SCRIPT, `--exit-first=${markerFile}`, `--append-grandchild=${pidFile}`],
          },
        },
      };
      session = await runner.start(session);
      const pids = (await readFile(pidFile, 'utf8')).trim().split(/\s+/).map(Number);
      strayPids.push(...pids);
      expect(pids).toHaveLength(4);

      await runner.stop(session);

      await vi.waitFor(() => expect(pids.every((pid) => !isAlive(pid))).toBe(true));
      strayPids.splice(0);
    },
    10_000,
  );

  it.runIf(process.platform !== 'win32')(
    'SIGTERMs then SIGKILLs the complete preview process tree',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'preview-process-tree-'));
      temporaryDirectories.push(directory);
      const pidFile = join(directory, 'pids');
      const runner = new NodePreviewRunner({
        startupTimeoutMs: 5_000,
        logRepository: new InMemoryPreviewLogRepository(),
      });
      let session = await newSession('sess-tree');
      session = await runner.prepare(session);
      session = {
        ...session,
        commandPlan: {
          ...session.commandPlan!,
          dev: {
            ok: true,
            command: 'node',
            args: [FIXTURE_SCRIPT, `--spawn-grandchild=${pidFile}`, '--ignore-sigterm'],
          },
        },
      };
      session = await runner.start(session);
      const [childPid, grandchildPid] = (await readFile(pidFile, 'utf8'))
        .trim()
        .split(' ')
        .map(Number);
      strayPids.push(childPid!, grandchildPid!);

      const failed = PreviewSessionSchema.parse({
        ...session,
        status: 'failed',
        error: {
          name: 'PreviewRuntimeError',
          code: 'PREVIEW_CRASHED',
          message: 'Dev server exited.',
        },
        completedAt: new Date().toISOString(),
      });
      await runner.stop(failed);

      await vi.waitFor(() => {
        expect(isAlive(childPid!)).toBe(false);
        expect(isAlive(grandchildPid!)).toBe(false);
      });
      strayPids.splice(0);
    },
    10_000,
  );

  it.runIf(process.platform !== 'win32')(
    'kills descendants left behind when the preview process exits first',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'preview-orphan-tree-'));
      temporaryDirectories.push(directory);
      const pidFile = join(directory, 'pids');
      const runner = new NodePreviewRunner({
        startupTimeoutMs: 5_000,
        logRepository: new InMemoryPreviewLogRepository(),
      });
      let session = await newSession('sess-orphan-tree');
      session = await runner.prepare(session);
      session = {
        ...session,
        commandPlan: {
          ...session.commandPlan!,
          dev: {
            ok: true,
            command: 'node',
            args: [FIXTURE_SCRIPT, `--spawn-grandchild=${pidFile}`, '--exit-after-ready'],
          },
        },
      };
      session = await runner.start(session);
      const [, grandchildPid] = (await readFile(pidFile, 'utf8')).trim().split(' ').map(Number);
      strayPids.push(grandchildPid!);
      await vi.waitFor(async () => {
        await expect(runner.health(session)).resolves.toMatchObject({
          state: 'unhealthy',
          detail: 'process not running',
        });
      });

      await runner.stop(session);

      await vi.waitFor(() => expect(isAlive(grandchildPid!)).toBe(false));
      strayPids.splice(0);
    },
    10_000,
  );

  it('gives two concurrent sessions distinct ports', async () => {
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000 });
    const build = async (id: string) => {
      let session = await newSession(id);
      session = await runner.prepare(session);
      session = {
        ...session,
        commandPlan: {
          ...session.commandPlan!,
          dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
        },
      };
      return runner.start(session);
    };
    const [a, b] = await Promise.all([build('sess-b'), build('sess-c')]);
    expect(a.process?.port).not.toBe(b.process?.port);
    await Promise.all([runner.stop(a), runner.stop(b)]);
  }, 15_000);

  // The task brief's original version of this test built the dev command's
  // args from `takenPorts` *before* the injected reservePort() mock ever ran
  // (args are computed once, synchronously, while reservePort is only
  // invoked later inside start()). That means `takenPorts` was always `[]`
  // at command-build time, so the "conflict" command never actually bound
  // the reserved port -- it silently fell back to `.listen(0)`, a random
  // free port. It could never deterministically create a bind conflict, so
  // per the task brief's Step 6 guidance ("if flaky, simplify to just
  // asserting start() settles"), this is rewritten to directly and
  // deterministically exercise the same code path (spawn() retries once on
  // immediate crash, then fails) instead of relying on a racy real port
  // conflict.
  it('binds the dev server to the port returned by the injected reservePort seam', async () => {
    // Reserve a real free port the same bind-then-release way preview-port.test.ts
    // does, then inject it so we can prove the runner uses exactly that port end
    // to end (not just that the injection seam exists).
    const freePort = await new Promise<number>((resolvePromise, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolvePromise(port));
      });
    });
    const runner = new NodePreviewRunner({
      startupTimeoutMs: 5_000,
      reservePort: async () => freePort,
    });
    let session = await newSession('sess-reserve');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: [FIXTURE_SCRIPT] },
      },
    };
    session = await runner.start(session);
    expect(session.status).toBe('starting');
    expect(session.process?.port).toBe(freePort);
    await runner.stop(session);
  }, 15_000);

  it('fails after two immediate crashes instead of hanging', async () => {
    const runner = new NodePreviewRunner({ startupTimeoutMs: 3_000 });
    let session = await newSession('sess-d');
    session = await runner.prepare(session);
    session = {
      ...session,
      commandPlan: {
        ...session.commandPlan!,
        dev: { ok: true, command: 'node', args: ['-e', 'process.exit(1)'] },
      },
    };
    const result = await runner.start(session);
    expect(result.status).toBe('failed');
    await runner.stop(result).catch(() => undefined);
  }, 15_000);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
