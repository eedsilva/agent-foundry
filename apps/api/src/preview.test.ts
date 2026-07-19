import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewSession } from '@agent-foundry/contracts';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(options?: {
  loggerStream?: { write(message: string): void };
}): Promise<{ baseUrl: string; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'preview-worker',
    PREVIEW_TTL_SECONDS: '60',
  });
  const app = await buildApp(runtime, options);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { baseUrl, runtime };
}

async function createProject(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Preview sample', prd: 'x'.repeat(60) }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

async function createStoredSession(runtime: Runtime, projectId: string): Promise<PreviewSession> {
  const now = new Date().toISOString();
  const session: PreviewSession = {
    id: `preview-${projectId}`,
    workspaceRef: { projectId, workspacePath: runtime.workspaces.workspacePath(projectId) },
    status: 'stopped',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: 60 },
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  };
  await runtime.previewSessions.create({ session, tokenDigest: 'a'.repeat(64) });
  return session;
}

async function createActiveSession(runtime: Runtime, projectId: string): Promise<PreviewSession> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString(); // 1 hour from now
  const session: PreviewSession = {
    id: `preview-active-${projectId}`,
    workspaceRef: { projectId, workspacePath: runtime.workspaces.workspacePath(projectId) },
    status: 'running',
    version: 1,
    url: `http://127.0.0.1/preview/preview-active-${projectId}/`,
    process: { command: 'npm', args: ['run', 'dev'] },
    health: { state: 'healthy', consecutiveFailures: 0 },
    ttl: { seconds: 60, expiresAt },
    restartCount: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
  };
  await runtime.previewSessions.create({ session, tokenDigest: 'a'.repeat(64) });
  return session;
}

describe('preview routes', () => {
  it('starts and stops a preview session for a project', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    await runtime.workspaces.ensure(projectId);
    const workspacePath = runtime.workspaces.workspacePath(projectId);
    await writeFile(
      join(workspacePath, 'package.json'),
      JSON.stringify({ scripts: { dev: 'node -e "process.exit(1)"' } }),
    );

    const startResponse = await fetch(`${baseUrl}/projects/${projectId}/preview`, {
      method: 'POST',
    });
    expect(startResponse.status).toBe(202);
    const started = (await startResponse.json()) as {
      session: { id: string; status: string };
      url: string;
    };
    expect(['starting', 'failed']).toContain(started.session.status); // a dev command that exits 1 fails fast; still proves the wiring

    const stopResponse = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${started.session.id}/stop`,
      { method: 'POST' },
    );
    expect(stopResponse.status).toBe(202);
    const stopped = (await stopResponse.json()) as { session: { status: string } };
    expect(['stopped', 'failed']).toContain(stopped.session.status);
  });

  it('404s stopping an unknown session', async () => {
    const { baseUrl } = await startApi();
    const projectId = await createProject(baseUrl);
    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/does-not-exist/stop`, {
      method: 'POST',
    });
    expect(response.status).toBe(404);
  });

  it('returns cursor-paginated preview logs with a default limit', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createStoredSession(runtime, projectId);
    await runtime.previewLogs.append(session.id, {
      timestamp: new Date().toISOString(),
      stream: 'stdout',
      message: 'first',
    });
    await runtime.previewLogs.append(session.id, {
      timestamp: new Date().toISOString(),
      stream: 'stderr',
      message: 'second',
    });

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${session.id}/logs?cursor=1`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [{ cursor: 2, stream: 'stderr', message: 'second' }],
      nextCursor: 2,
    });
  });

  it.each([
    'cursor=',
    'cursor=%20',
    'cursor=-1',
    'cursor=%2B1',
    'cursor=01',
    'cursor=0x10',
    'cursor=1e2',
    'cursor=1.5',
    'limit=',
    'limit=%2B1',
    'limit=01',
    'limit=1e2',
    'limit=0',
    'limit=201',
  ])('rejects invalid %s', async (query) => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createStoredSession(runtime, projectId);

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${session.id}/logs?${query}`,
    );

    expect(response.status).toBe(400);
  });

  it('accepts canonical cursor and limit decimals at their boundaries', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createStoredSession(runtime, projectId);

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${session.id}/logs?cursor=0&limit=200`,
    );

    expect(response.status).toBe(200);
  });

  it('redacts case-insensitive and encoded token query keys from access logs', async () => {
    const lines: string[] = [];
    const { baseUrl } = await startApi({
      loggerStream: { write: (message) => lines.push(message) },
    });
    const rawToken = 'raw-secret-token';
    const encodedKeyToken = 'encoded-key-secret';

    await fetch(
      `${baseUrl}/preview/unknown/?ToKeN=${rawToken}&%74oken=${encodedKeyToken}&keep=yes`,
    );

    const output = lines.join('');
    expect(output).toContain('keep=yes');
    expect(output).toContain('REDACTED');
    expect(output).not.toContain(rawToken);
    expect(output).not.toContain(encodedKeyToken);
    expect(output).not.toContain(encodeURIComponent(rawToken));
    expect(output).not.toContain(encodeURIComponent(encodedKeyToken));
  });

  it('does not expose or stop a preview through another project', async () => {
    const { baseUrl, runtime } = await startApi();
    const ownerId = await createProject(baseUrl);
    const otherId = await createProject(baseUrl);
    const session = await createStoredSession(runtime, ownerId);

    const logs = await fetch(`${baseUrl}/projects/${otherId}/preview/${session.id}/logs`);
    const stop = await fetch(`${baseUrl}/projects/${otherId}/preview/${session.id}/stop`, {
      method: 'POST',
    });

    expect(logs.status).toBe(404);
    expect(stop.status).toBe(404);
  });

  it('passes the project current run to preview start', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const project = await runtime.projects.get(projectId);
    expect(project?.currentRunId).toBeDefined();
    const start = vi.spyOn(runtime.previewService, 'start').mockResolvedValue({
      session: await createStoredSession(runtime, projectId),
      url: 'http://127.0.0.1/preview',
    });

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview`, { method: 'POST' });

    expect(response.status).toBe(202);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ runId: project!.currentRunId }));
  });
});

describe('GET /projects/:projectId/preview/active', () => {
  it('returns null when no session is active', async () => {
    const { baseUrl } = await startApi();
    const projectId = await createProject(baseUrl);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session: null });
  });

  it('returns the active session for a project', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, projectId);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ session });
  });

  it('does not return a stopped session', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    await createStoredSession(runtime, projectId);

    const response = await fetch(`${baseUrl}/projects/${projectId}/preview/active`);

    expect(await response.json()).toEqual({ session: null });
  });

  it("does not return another project's active session", async () => {
    const { baseUrl, runtime } = await startApi();
    const ownerId = await createProject(baseUrl);
    const otherId = await createProject(baseUrl);
    await createActiveSession(runtime, ownerId);

    const response = await fetch(`${baseUrl}/projects/${otherId}/preview/active`);

    expect(await response.json()).toEqual({ session: null });
  });
});

describe('preview reaper schedule', () => {
  it('is not started by generic app construction', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-reaper-'));
    dirs.push(dataDir);
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      PREVIEW_REAP_INTERVAL_MS: '10',
    });
    const reap = vi.spyOn(runtime.previewService, 'reap');
    vi.useFakeTimers();
    const app = await buildApp(runtime);
    apps.push(app);

    await vi.advanceTimersByTimeAsync(30);
    expect(reap).not.toHaveBeenCalled();

    await app.close();
    vi.useRealTimers();
  });
});

describe('POST /projects/:projectId/preview/:sessionId/selection', () => {
  it('resolves a selection with no candidates as unsupported', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, projectId);
    const response = await fetch(
      `${baseUrl}/projects/${projectId}/preview/${session.id}/selection`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewUrl: `${baseUrl}/preview/${session.id}/`,
          domPath: 'div[1]',
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          computedStyle: {},
          candidates: [],
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('unsupported');
  });

  it("404s for a selection posted against another project's session", async () => {
    const { baseUrl, runtime } = await startApi();
    const ownerId = await createProject(baseUrl);
    const otherId = await createProject(baseUrl);
    const session = await createActiveSession(runtime, ownerId);
    const response = await fetch(
      `${baseUrl}/projects/${otherId}/preview/${session.id}/selection`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          previewUrl: `${baseUrl}/preview/${session.id}/`,
          domPath: 'div[1]',
          boundingBox: { x: 0, y: 0, width: 10, height: 10 },
          computedStyle: {},
          candidates: [],
        }),
      },
    );
    expect(response.status).toBe(404);
  });
});
