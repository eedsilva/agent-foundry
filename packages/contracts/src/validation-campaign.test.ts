import { describe, expect, it } from 'vitest';
import {
  createValidationCampaignExecution,
  ValidationCampaignExecutionSchema,
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
  allowedModels: [identity, { ...identity, id: 'haiku', provider: 'claude', model: 'haiku' }],
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
      selected: { ...identity, id: 'haiku', provider: 'claude', model: 'haiku' },
      fallbacks: [],
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

  it('rejects a route identity that is not in the allowed campaign snapshot', () => {
    expect(() =>
      ValidationCampaignPreviewSchema.parse({
        ...preview,
        routes: [
          {
            ...preview.routes[0]!,
            selected: { ...preview.routes[0]!.selected, model: 'drifted-model' },
          },
        ],
      }),
    ).toThrow(/allowed campaign identity/);
  });

  it('persists the complete preview with independent active-time and repair accounting', () => {
    const execution = createValidationCampaignExecution(
      ValidationCampaignPreviewSchema.parse(preview),
    );

    expect(ValidationCampaignExecutionSchema.parse(execution)).toEqual({
      preview,
      activeElapsedMs: 0,
      targetedRepairs: 0,
    });
    expect(
      ValidationCampaignExecutionSchema.parse({
        ...execution,
        activeElapsedMs: 45 * 60 * 1_000,
        targetedRepairs: 1,
      }),
    ).toMatchObject({ activeElapsedMs: 2_700_000, targetedRepairs: 1 });
  });
});
