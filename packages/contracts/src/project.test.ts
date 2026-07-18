import { describe, expect, it } from 'vitest';
import { ArtifactMetadataSchema } from './project.js';

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
