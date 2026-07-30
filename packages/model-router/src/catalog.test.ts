import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModelCatalog } from './catalog.js';

const repoRoot = resolve(import.meta.dirname, '../../..');

describe('model catalog', () => {
  it('registers GLM as a metered cheap hosted model', async () => {
    const models = await loadModelCatalog(resolve(repoRoot, 'models/catalog.yaml'));
    const glm = models.find((model) => model.id === 'glm-fast');

    expect(glm).toMatchObject({
      provider: 'glm',
      model: 'GLM-4.5-Air',
      billingMode: 'metered',
      pricing: {
        inputUsdPerMillionTokens: 0.2,
        outputUsdPerMillionTokens: 1.1,
      },
    });
  });
});
