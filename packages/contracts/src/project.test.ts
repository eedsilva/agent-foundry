import { describe, expect, it } from 'vitest';
import { ArtifactMetadataSchema, ExecutorHealthSchema, QueueJobSchema } from './project.js';

describe('ArtifactMetadataSchema', () => {
  it('leaves storage unset for an existing JSON artifact and accepts it unchanged', () => {
    const parsed = ArtifactMetadataSchema.parse({
      projectId: 'project-1',
      name: 'prd',
      revision: 1,
      contentType: 'text/markdown',
      createdAt: '2026-07-17T12:00:00.000Z',
      createdBy: 'user',
      sha256: 'a'.repeat(64),
    });
    expect(parsed.storage).toBeUndefined();
    expect(parsed.sizeBytes).toBeUndefined();
  });

  it('accepts a blob artifact with size, expiry, and deletion metadata', () => {
    const parsed = ArtifactMetadataSchema.parse({
      projectId: 'project-1',
      name: 'browser-screenshot-preview-1-open-items',
      revision: 1,
      contentType: 'image/png',
      createdAt: '2026-07-17T12:00:00.000Z',
      createdBy: 'browser-verifier',
      sha256: 'b'.repeat(64),
      storage: 'blob',
      sizeBytes: 48_211,
      expiresAt: '2026-07-24T12:00:00.000Z',
    });
    expect(parsed.storage).toBe('blob');
    expect(parsed.sizeBytes).toBe(48_211);
    expect(parsed.blobDeleted).toBeUndefined();
  });
});

describe('QueueJobSchema job types (#37)', () => {
  it('accepts both run-project and run-conversation-operation jobs', () => {
    const base = {
      id: 'job-1',
      projectId: 'project-1',
      workflowId: 'conversation-plan',
      attempts: 0,
      maxAttempts: 1,
      createdAt: '2026-07-18T12:00:00.000Z',
      availableAt: '2026-07-18T12:00:00.000Z',
      leaseEpoch: 0,
    };
    expect(
      QueueJobSchema.parse({
        ...base,
        type: 'run-conversation-operation',
        runId: 'run-1',
        operationId: 'operation-1',
      }),
    ).toMatchObject({ type: 'run-conversation-operation', operationId: 'operation-1' });
    expect(
      QueueJobSchema.parse({ ...base, type: 'run-project', workflowId: 'web-app-v1' }),
    ).toMatchObject({
      type: 'run-project',
    });
    expect(() => QueueJobSchema.parse({ ...base, type: 'bogus' })).toThrow();
  });
});

describe('ExecutorHealthSchema rate limit', () => {
  it('accepts optional rate limit with reset', () => {
    const health = ExecutorHealthSchema.parse({
      provider: 'claude',
      available: true,
      message: 'ok',
      rateLimit: { limit: 100, remaining: 4, resetAt: '2026-07-18T12:00:00.000Z' },
    });
    expect(health.rateLimit?.remaining).toBe(4);
  });

  it('omits rate limit when unknown', () => {
    const health = ExecutorHealthSchema.parse({
      provider: 'codex',
      available: true,
      message: 'ok',
    });
    expect(health.rateLimit).toBeUndefined();
  });
});
