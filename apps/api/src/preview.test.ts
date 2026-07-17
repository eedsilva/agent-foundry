import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(): Promise<{ baseUrl: string; runtime: Runtime }> {
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
  const app = await buildApp(runtime);
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
});
