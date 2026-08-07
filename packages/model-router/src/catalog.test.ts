import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from './catalog.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('model catalog', () => {
  it('registers only the two product providers (#438)', async () => {
    const models = await loadModelCatalog(resolve(repoRoot, 'models/catalog.yaml'));

    expect(models.length).toBeGreaterThan(0);
    expect([...new Set(models.map((model) => model.provider))].sort()).toEqual(['claude', 'codex']);
  });
});
