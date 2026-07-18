import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
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
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-artifacts-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'artifacts-worker',
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
    body: JSON.stringify({ name: 'Artifact sample', prd: 'x'.repeat(60) }),
  });
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

describe('artifact blob download route', () => {
  it('streams a blob artifact with its content type and length', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const content = Buffer.from('a screenshot, pretend');
    await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-screenshot-preview-1-open-items',
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(content),
    );

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/artifacts/browser-screenshot-preview-1-open-items/blob`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-length')).toBe(String(content.byteLength));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(content);
  });

  it('returns 404 for an artifact that was never written', async () => {
    const { baseUrl, projectId } = await (async () => {
      const started = await startApi();
      return { ...started, projectId: await createProject(started.baseUrl) };
    })();

    const response = await fetch(`${baseUrl}/projects/${projectId}/artifacts/missing/blob`);
    expect(response.status).toBe(404);
  });

  it('returns 410 for a blob that already expired and was reaped', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    const metadata = await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-trace-preview-1',
        contentType: 'application/zip',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 1,
      },
      Readable.from(Buffer.from('trace bytes')),
    );
    await runtime.artifacts.reapExpired(new Date(Date.parse(metadata.expiresAt!) + 1_000));

    const response = await fetch(
      `${baseUrl}/projects/${projectId}/artifacts/browser-trace-preview-1/blob`,
    );
    expect(response.status).toBe(410);
  });
});
