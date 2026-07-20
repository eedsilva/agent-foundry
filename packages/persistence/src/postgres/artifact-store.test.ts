import { Readable } from 'node:stream';
import { expect, it } from 'vitest';
import type { Project } from '@agent-foundry/contracts';
import { ArtifactTooLargeError } from '@agent-foundry/domain';
import { PostgresArtifactStore } from './artifact-store.js';
import { PostgresProjectRepository } from './project-repository.js';
import { describePostgres } from './testing.js';

const createdAt = '2026-07-14T12:00:00.000Z';

function makeProject(id = 'project-1'): Project {
  return {
    id,
    name: 'Project',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

describePostgres('PostgresArtifactStore', (ctx) => {
  it('puts and reads back an inline artifact, listing metadata and latest', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);

    const stored = await store.put({
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'add tests' },
      createdBy: 'approval-gate:gate',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      kind: 'feedback',
      actor: { kind: 'user', id: 'ed' },
      sourceDecisionId: 'decision-1',
    });

    expect(stored).toMatchObject({
      metadata: {
        projectId: 'project-1',
        name: 'repair-notes',
        revision: 1,
        kind: 'feedback',
        actor: { kind: 'user', id: 'ed' },
        sourceDecisionId: 'decision-1',
      },
      content: { schemaVersion: '1', note: 'add tests' },
    });
    expect(stored.metadata.sha256).toMatch(/^[a-f0-9]{64}$/);

    await expect(store.getRevision('project-1', 'repair-notes', 1)).resolves.toEqual(stored);
    await expect(store.getLatest('project-1', 'repair-notes')).resolves.toEqual(stored);
    await expect(store.listMetadata('project-1', 'repair-notes')).resolves.toEqual([
      stored.metadata,
    ]);
    await expect(store.listLatest('project-1')).resolves.toEqual([stored]);
    await expect(store.getRevision('project-1', 'repair-notes', 2)).resolves.toBeNull();
  });

  it('allocates unique monotonic revisions under 5 concurrent puts of the same name', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.put({
          projectId: 'project-1',
          name: 'race-artifact',
          content: { schemaVersion: '1', i },
          createdBy: 'test',
        }),
      ),
    );

    const revisions = results.map((r) => r.metadata.revision).sort((a, b) => a - b);
    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(revisions).size).toBe(5);
  });

  it('returns the same revision for concurrent puts sharing a sourceDecisionId', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);
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

  it('returns the same revision for concurrent puts sharing an idempotencyKey', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);
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

  it('streams a blob to Postgres and reads it back byte-for-byte with sha256/sizeBytes', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);
    const content = Buffer.from('a screenshot, pretend');

    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1',
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
    expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/);

    const stream = await store.getBlobStream('project-1', 'browser-screenshot-preview-1', 1);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(content);
  });

  it('rejects a blob over maxBytes and leaves no row behind', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);

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
    ).rejects.toThrow(ArtifactTooLargeError);

    await expect(store.listMetadata('project-1', 'browser-trace-preview-1')).resolves.toEqual([]);
  });

  it('returns null for a blob that was never written', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);

    await expect(store.getBlobStream('project-1', 'nonexistent', 1)).resolves.toBeNull();
  });

  it('reaps expired blobs, deletes their bytes, and keeps metadata with blobDeleted true', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresArtifactStore(sql);
    const content = Buffer.from('expires now');

    const metadata = await store.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-video-preview-1',
        contentType: 'video/webm',
        createdBy: 'browser-verifier',
        maxBytes: 1_000,
        retentionSeconds: 0,
      },
      Readable.from(content),
    );
    expect(metadata.expiresAt).toBeTruthy();

    const future = new Date(Date.parse(metadata.expiresAt!) + 60_000);
    await expect(store.reapExpired(future)).resolves.toBe(1);

    await expect(
      store.getBlobStream('project-1', 'browser-video-preview-1', 1),
    ).resolves.toBeNull();

    const survivingMetadata = await store.listMetadata('project-1', 'browser-video-preview-1');
    expect(survivingMetadata).toHaveLength(1);
    expect(survivingMetadata[0]).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });

    const revision = await store.getRevision('project-1', 'browser-video-preview-1', 1);
    expect(revision?.metadata).toMatchObject({ blobDeleted: true, sha256: metadata.sha256 });

    // A second reap sweep finds nothing left to do.
    await expect(store.reapExpired(future)).resolves.toBe(0);
  });

  it('rejects put and putBlob for an unknown project (FK violation)', async () => {
    const sql = ctx.db();
    const store = new PostgresArtifactStore(sql);

    await expect(
      store.put({
        projectId: 'missing-project',
        name: 'repair-notes',
        content: { schemaVersion: '1' },
        createdBy: 'test',
      }),
    ).rejects.toThrow(/artifacts/);

    await expect(
      store.putBlob(
        {
          projectId: 'missing-project',
          name: 'browser-screenshot',
          contentType: 'image/png',
          createdBy: 'test',
          maxBytes: 1_000,
        },
        Readable.from(Buffer.from('bytes')),
      ),
    ).rejects.toThrow(/artifacts/);
  });
});
