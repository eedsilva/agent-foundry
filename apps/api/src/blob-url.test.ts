import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, signBlobToken, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startApi(): Promise<{ app: FastifyInstance; runtime: Runtime }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-url-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'blob-url-worker',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  return { app, runtime };
}

async function createProject(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'Blob URL sample', prd: 'x'.repeat(60) },
  });
  const { project } = response.json() as { project: { id: string } };
  return project.id;
}

/** Extracts a `/blobs/...` signed-download URL's path + query for use with app.inject. */
function pathAndQuery(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

describe('signed blob download URLs', () => {
  it('issues a short-lived URL fetchable on the fs token route', async () => {
    const { app, runtime } = await startApi();
    const projectId = await createProject(app);
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

    const urlResponse = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/artifacts/browser-screenshot-preview-1-open-items/blob-url`,
    });
    expect(urlResponse.statusCode).toBe(200);
    const body = urlResponse.json() as { url: string; expiresAt: string };
    expect(body.url).toContain('/blobs/');
    expect(body.url).toContain('token=');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const blobResponse = await app.inject({ method: 'GET', url: pathAndQuery(body.url) });
    expect(blobResponse.statusCode).toBe(200);
    expect(blobResponse.headers['content-type']).toBe('image/png');
    expect(blobResponse.rawPayload).toEqual(content);
  });

  it('rejects an expired token with 403', async () => {
    const { app, runtime } = await startApi();
    const projectId = await createProject(app);
    const metadata = await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-trace-expired',
        contentType: 'application/zip',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(Buffer.from('trace bytes')),
    );
    const key = `projects/${projectId}/artifacts/${metadata.name}/${String(metadata.revision).padStart(6, '0')}`;
    const expiredToken = signBlobToken(runtime.config.blobSigningSecret!, key, Date.now() - 1_000);

    const response = await app.inject({
      method: 'GET',
      url: `/blobs/${encodeURIComponent(key)}?token=${expiredToken}`,
    });
    expect(response.statusCode).toBe(403);
  });

  it('returns 410 for a blob-url request against an already-expired, reaped blob', async () => {
    const { app, runtime } = await startApi();
    const projectId = await createProject(app);
    const metadata = await runtime.artifacts.putBlob(
      {
        projectId,
        name: 'browser-trace-gone',
        contentType: 'application/zip',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 1,
      },
      Readable.from(Buffer.from('trace bytes')),
    );
    await runtime.artifacts.reapExpired(new Date(Date.parse(metadata.expiresAt!) + 1_000));

    const response = await app.inject({
      method: 'GET',
      url: `/projects/${projectId}/artifacts/browser-trace-gone/blob-url`,
    });
    expect(response.statusCode).toBe(410);
  });

  it('returns 404 for an unknown project', async () => {
    const { app } = await startApi();

    const response = await app.inject({
      method: 'GET',
      url: '/projects/does-not-exist/artifacts/whatever/blob-url',
    });
    expect(response.statusCode).toBe(404);
  });
});
