import { createHash } from 'node:crypto';
import type { StoredArtifact } from '@agent-foundry/contracts';
import { describe, expect, it } from 'vitest';
import { artifactMatchesReference } from './idempotency.js';

describe('artifactMatchesReference', () => {
  it('does not reject structured artifacts when a JSONB round-trip reorders object keys', () => {
    const sha256 = createHash('sha256')
      .update(JSON.stringify({ z: 1, a: 2 }))
      .digest('hex');
    const artifact: StoredArtifact = {
      metadata: {
        projectId: 'project-1',
        name: 'plan',
        revision: 1,
        contentType: 'application/json',
        createdAt: '2026-09-03T00:00:00.000Z',
        createdBy: 'agent',
        sha256,
      },
      content: { a: 2, z: 1 },
    };

    expect(artifactMatchesReference(artifact, { name: 'plan', revision: 1, sha256 })).toBe(true);
  });
});
