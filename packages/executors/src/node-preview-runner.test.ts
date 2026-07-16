import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connect, createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PreviewSessionSchema, type PreviewSession } from '@agent-foundry/contracts';
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
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

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
    const runner = new NodePreviewRunner({ startupTimeoutMs: 5_000 });
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
    expect(logOutput).toContain('VITE fixture');

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
