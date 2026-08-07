import { describe, expect, it } from 'vitest';
import type { ModelDefinition } from '@agent-foundry/contracts';
import { buildValidationCampaignPreview } from './validation-campaign.js';

const capabilities = {
  planning: 0.5,
  architecture: 0.5,
  coding: 0.5,
  review: 0.5,
  repair: 0.5,
  structuredOutput: 0.5,
  speed: 0.5,
  costEfficiency: 0.5,
  reliability: 0.5,
};

function model(overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: 'codex-extra',
    provider: 'codex',
    model: 'gpt-5.3-codex',
    billingMode: 'metered',
    enabled: true,
    requireExplicitModel: false,
    maxContextTokens: 65_536,
    canWriteWorkspace: true,
    tags: ['local', 'verification'],
    capabilities,
    ...overrides,
  };
}

function catalog(): ModelDefinition[] {
  return [
    model(),
    model({
      id: 'claude-haiku',
      provider: 'claude',
      model: 'claude-haiku-4-5-20251001',
      tags: ['fast'],
    }),
    model({ id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna', tags: ['coding'] }),
    model({ id: 'claude-opus', provider: 'claude', model: 'opus', tags: ['reasoning'] }),
  ];
}

describe('buildValidationCampaignPreview', () => {
  it('returns only the restricted catalog and bounded routes', () => {
    const preview = buildValidationCampaignPreview(catalog(), 'a'.repeat(40));

    expect(preview.allowedModels.map((entry) => entry.id)).toEqual([
      'claude-haiku',
      'codex-default',
    ]);
    expect(preview.routes).toEqual([
      {
        taskKind: 'planning',
        selected: expect.objectContaining({ id: 'claude-haiku' }),
        fallbacks: [expect.objectContaining({ id: 'claude-haiku' })],
      },
      {
        taskKind: 'implementation',
        selected: expect.objectContaining({ id: 'codex-default' }),
        fallbacks: [expect.objectContaining({ id: 'codex-default' })],
      },
      {
        taskKind: 'repair',
        selected: expect.objectContaining({ id: 'codex-default' }),
        fallbacks: [
          expect.objectContaining({ id: 'codex-default' }),
          expect.objectContaining({ id: 'codex-default' }),
        ],
      },
      {
        taskKind: 'verification',
        selected: expect.objectContaining({ id: 'claude-haiku' }),
        fallbacks: [expect.objectContaining({ id: 'claude-haiku' })],
      },
    ]);
    expect(preview.limits).toEqual({
      attemptsPerAgentStep: 2,
      targetedRepairs: 3,
      activeTimeMinutes: 60,
      meteredCostUsd: 2,
    });
  });

  it.each([
    [
      'missing',
      (models: ModelDefinition[]) => models.filter((entry) => entry.id !== 'claude-haiku'),
    ],
    [
      'disabled',
      (models: ModelDefinition[]) =>
        models.map((entry) => (entry.id === 'claude-haiku' ? { ...entry, enabled: false } : entry)),
    ],
    [
      'ambiguous',
      (models: ModelDefinition[]) => [
        ...models,
        model({ id: 'claude-haiku', provider: 'claude', model: 'claude-haiku-4-5-20251001' }),
      ],
    ],
    [
      'drifted',
      (models: ModelDefinition[]) =>
        models.map((entry) =>
          entry.id === 'codex-default' ? { ...entry, model: 'gpt-5.6-sol' } : entry,
        ),
    ],
  ])('fails closed for a %s expected identity', (_reason, mutate) => {
    expect(() => buildValidationCampaignPreview(mutate(catalog()), 'a'.repeat(40))).toThrow(
      /validation campaign/i,
    );
  });

  it('never exposes a premium model in the automatic route', () => {
    const preview = buildValidationCampaignPreview(catalog(), 'a'.repeat(40));
    const routeModels = preview.routes.flatMap((route) => [route.selected, ...route.fallbacks]);
    expect(routeModels.map((entry) => entry.id)).not.toContain('claude-opus');
  });
});
