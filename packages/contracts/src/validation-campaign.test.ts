import { describe, expect, it } from 'vitest';
import {
  ValidationCampaignPreviewSchema,
  ValidationCampaignResponseSchema,
} from './validation-campaign.js';

const identity = {
  id: 'model',
  provider: 'codex' as const,
  model: 'gpt-5.6-luna',
};

const preview = {
  schemaVersion: '1' as const,
  id: 'real-todo-v1' as const,
  name: 'Real TODO validation campaign',
  sourceRevision: 'a'.repeat(40),
  allowedModels: [
    identity,
    { ...identity, id: 'local', provider: 'opencode', model: 'qwen' },
    { ...identity, id: 'haiku', provider: 'claude', model: 'haiku' },
  ],
  routes: [
    {
      taskKind: 'planning' as const,
      selected: { ...identity, id: 'haiku', provider: 'claude', model: 'haiku' },
      fallbacks: [],
    },
    { taskKind: 'implementation' as const, selected: identity, fallbacks: [] },
    { taskKind: 'repair' as const, selected: identity, fallbacks: [] },
    {
      taskKind: 'verification' as const,
      selected: { ...identity, id: 'local', provider: 'opencode', model: 'qwen' },
      fallbacks: [{ ...identity, id: 'haiku', provider: 'claude', model: 'haiku' }],
    },
  ],
  limits: {
    attemptsPerAgentStep: 1,
    targetedRepairs: 1,
    activeTimeMinutes: 45,
    meteredCostUsd: 2,
  },
};

describe('validation campaign contracts', () => {
  it('accepts the bounded route preview shape', () => {
    expect(ValidationCampaignPreviewSchema.parse(preview)).toEqual(preview);
  });

  it('accepts an unselected campaign response', () => {
    expect(
      ValidationCampaignResponseSchema.parse({
        availableCampaigns: ['real-todo-v1'],
        selectedCampaign: null,
        preview: null,
      }),
    ).toMatchObject({ selectedCampaign: null, preview: null });
  });

  it('rejects a source revision that is not a full git SHA', () => {
    expect(() =>
      ValidationCampaignPreviewSchema.parse({ ...preview, sourceRevision: 'main' }),
    ).toThrow();
  });
});
