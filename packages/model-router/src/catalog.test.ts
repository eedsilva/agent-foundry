import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from './catalog.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('model catalog', () => {
  it('pins the Economy Profile to exact Haiku and Luna High identities (#603)', async () => {
    const models = await loadModelCatalog(resolve(repoRoot, 'models/catalog.yaml'));

    expect(models).toEqual([
      expect.objectContaining({
        id: 'codex-default',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
      }),
      expect.objectContaining({
        id: 'claude-haiku',
        provider: 'claude',
        model: 'claude-haiku-4-5-20251001',
      }),
    ]);
  });
});
