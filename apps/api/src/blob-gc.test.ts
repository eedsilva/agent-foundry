import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { blobKeyFor, createRuntime, type Runtime } from '@agent-foundry/composition';
import { sweepUnreferencedBlobs } from './blob-gc.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRuntime(): Promise<Runtime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-gc-'));
  dirs.push(dataDir);
  return createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'blob-gc-worker',
  });
}

const GRACE_MS = 86_400_000;

describe('sweepUnreferencedBlobs', () => {
  it('never deletes a blob current artifact metadata still references, however old', async () => {
    const runtime = await makeRuntime();
    const project = await runtime.projectService.create({
      name: 'GC referenced',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const metadata = await runtime.artifacts.putBlob(
      {
        projectId: project.id,
        name: 'browser-screenshot-referenced',
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(Buffer.from('kept bytes')),
    );
    const wayPastGrace = new Date(Date.now() + GRACE_MS * 10);

    const deleted = await sweepUnreferencedBlobs(runtime, GRACE_MS, wayPastGrace);

    expect(deleted).toBe(0);
    const key = blobKeyFor(project.id, metadata.name, metadata.revision);
    expect(await runtime.blobStore.stat(key)).not.toBeNull();
  });

  it('leaves a young unreferenced blob alone (allocated revision, metadata write still pending)', async () => {
    const runtime = await makeRuntime();
    const project = await runtime.projectService.create({
      name: 'GC young orphan',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const key = blobKeyFor(project.id, 'crashed-write', 1);
    await runtime.blobStore.put(
      { key, contentType: 'application/octet-stream', maxBytes: 1_000 },
      Readable.from(Buffer.from('orphan bytes')),
    );

    const deleted = await sweepUnreferencedBlobs(runtime, GRACE_MS, new Date());

    expect(deleted).toBe(0);
    expect(await runtime.blobStore.stat(key)).not.toBeNull();
  });

  it('deletes an unreferenced blob once it has outlived the grace period', async () => {
    const runtime = await makeRuntime();
    const project = await runtime.projectService.create({
      name: 'GC old orphan',
      prd: 'x'.repeat(60),
      workflowId: 'web-app-v1',
    });
    const key = blobKeyFor(project.id, 'crashed-write', 1);
    await runtime.blobStore.put(
      { key, contentType: 'application/octet-stream', maxBytes: 1_000 },
      Readable.from(Buffer.from('orphan bytes')),
    );
    const wayPastGrace = new Date(Date.now() + GRACE_MS * 10);

    const deleted = await sweepUnreferencedBlobs(runtime, GRACE_MS, wayPastGrace);

    expect(deleted).toBe(1);
    expect(await runtime.blobStore.stat(key)).toBeNull();
  });
});
