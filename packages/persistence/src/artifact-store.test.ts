import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from './artifact-store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FileArtifactStore feedback metadata', () => {
  it('persists typed feedback metadata and reconstructs the same hashed artifact', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-'));
    dirs.push(dataDir);
    const actor = { kind: 'user' as const, id: 'ed' };
    const first = new FileArtifactStore(dataDir);
    const stored = await first.put({
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'add tests' },
      createdBy: 'approval-gate:gate',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      kind: 'feedback',
      actor,
      sourceDecisionId: 'decision-1',
    });

    expect(stored.metadata).toMatchObject({
      kind: 'feedback',
      actor,
      sourceDecisionId: 'decision-1',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await expect(
      new FileArtifactStore(dataDir).getRevision('project-1', 'repair-notes', 1),
    ).resolves.toEqual(stored);
  });

  it('returns one revision for concurrent feedback writes from the same decision', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-race-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const input = {
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'add tests' },
      createdBy: 'approval-gate:gate',
      kind: 'feedback' as const,
      sourceDecisionId: 'decision-1',
    };

    const [left, right] = await Promise.all([store.put(input), store.put(input)]);

    expect(left).toEqual(right);
    await expect(store.listMetadata('project-1', 'repair-notes')).resolves.toHaveLength(1);
  });

  it('returns one revision for concurrent writes with the same artifact idempotency key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-artifact-idempotency-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const input = {
      projectId: 'project-1',
      name: 'preview-failure-session-1',
      content: { schemaVersion: '1', error: 'failed' },
      createdBy: 'preview-service',
      idempotencyKey: 'a'.repeat(64),
    };

    const [left, right] = await Promise.all([store.put(input), store.put(input)]);

    expect(left).toEqual(right);
    await expect(store.listMetadata('project-1', input.name)).resolves.toHaveLength(1);
  });
});

describe('FileArtifactStore blob storage', () => {
  it('streams a blob to disk and reads it back byte-for-byte', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const content = Buffer.from('a screenshot, pretend');

    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-items',
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
      },
      Readable.from(content),
    );

    expect(metadata).toMatchObject({
      storage: 'blob',
      contentType: 'image/png',
      sizeBytes: content.byteLength,
      revision: 1,
    });
    const stream = await store.getBlobStream(
      'project-1',
      'browser-screenshot-preview-1-open-items',
      1,
    );
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it('rejects a blob over the size limit and leaves no orphaned index entry', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-toolarge-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);

    await expect(
      store.putBlob(
        {
          projectId: 'project-1',
          name: 'browser-trace-preview-1',
          contentType: 'application/zip',
          createdBy: 'browser-verifier',
          maxBytes: 4,
        },
        Readable.from(Buffer.from('way more than four bytes')),
      ),
    ).rejects.toThrow(/exceeds the 4-byte limit/);

    await expect(store.listMetadata('project-1', 'browser-trace-preview-1')).resolves.toEqual([]);
  });

  it('returns null for a blob that was never written', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-missing-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);

    await expect(store.getBlobStream('project-1', 'nonexistent', 1)).resolves.toBeNull();
  });

  it('reaps expired blobs after their retention window without touching metadata', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-blob-reap-'));
    dirs.push(dataDir);
    const store = new FileArtifactStore(dataDir);
    const content = Buffer.from('expires soon');
    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-video-preview-1',
        contentType: 'video/webm',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 60,
      },
      Readable.from(content),
    );
    expect(metadata.expiresAt).toBeTruthy();

    const beforeExpiry = new Date(Date.parse(metadata.expiresAt!) - 1_000);
    await expect(store.reapExpired(beforeExpiry)).resolves.toBe(0);
    await expect(
      store.getBlobStream('project-1', 'browser-video-preview-1', 1),
    ).resolves.not.toBeNull();

    const afterExpiry = new Date(Date.parse(metadata.expiresAt!) + 1_000);
    await expect(store.reapExpired(afterExpiry)).resolves.toBe(1);
    await expect(
      store.getBlobStream('project-1', 'browser-video-preview-1', 1),
    ).resolves.toBeNull();

    const survivingMetadata = await store.listMetadata('project-1', 'browser-video-preview-1');
    expect(survivingMetadata).toHaveLength(1);
    expect(survivingMetadata[0]).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });

    const revision = await store.getRevision('project-1', 'browser-video-preview-1', 1);
    expect(revision?.metadata).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });

    const latest = await store.getLatest('project-1', 'browser-video-preview-1');
    expect(latest?.metadata).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });
  });
});
