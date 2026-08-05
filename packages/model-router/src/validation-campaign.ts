import {
  ValidationCampaignPreviewSchema,
  type ModelDefinition,
  type ValidationModelIdentity,
  type ValidationCampaignPreview,
} from '@agent-foundry/contracts';

export const REAL_TODO_VALIDATION_CAMPAIGN_ID = 'real-todo-v1' as const;

const CLAUDE_HAIKU_MODEL_ID = 'claude-haiku';
const CODEX_LUNA_MODEL_ID = 'codex-default';
const CODEX_LUNA_MODEL = 'gpt-5.6-luna';

export function buildValidationCampaignPreview(
  models: readonly ModelDefinition[],
  sourceRevision: string,
): ValidationCampaignPreview {
  const haiku = requireModel(models, CLAUDE_HAIKU_MODEL_ID, 'claude', 'haiku');
  const luna = requireModel(models, CODEX_LUNA_MODEL_ID, 'codex', CODEX_LUNA_MODEL);

  return ValidationCampaignPreviewSchema.parse({
    schemaVersion: '1',
    id: REAL_TODO_VALIDATION_CAMPAIGN_ID,
    name: 'Real TODO validation campaign',
    sourceRevision,
    allowedModels: [haiku, luna],
    routes: [
      { taskKind: 'planning', selected: haiku, fallbacks: [] },
      { taskKind: 'implementation', selected: luna, fallbacks: [] },
      { taskKind: 'repair', selected: luna, fallbacks: [] },
      { taskKind: 'verification', selected: haiku, fallbacks: [] },
    ],
    limits: {
      attemptsPerAgentStep: 1,
      targetedRepairs: 1,
      activeTimeMinutes: 45,
      meteredCostUsd: 2,
    },
  });
}

function requireModel(
  models: readonly ModelDefinition[],
  id: string,
  provider: ModelDefinition['provider'],
  expectedModel: string | undefined,
): ValidationModelIdentity {
  const matches = models.filter((candidate) => candidate.id === id);
  if (matches.length !== 1) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID} requires exactly one enabled model ${id}; found ${matches.length}`,
    );
  }

  const model = matches[0]!;
  if (!model.enabled) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID} requires enabled model ${id}`,
    );
  }
  if (model.provider !== provider) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID} model ${id} drifted provider: expected ${provider}, found ${model.provider}`,
    );
  }
  if (expectedModel !== undefined && model.model !== expectedModel) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID} model ${id} drifted identity: expected ${expectedModel}, found ${model.model || '<empty>'}`,
    );
  }
  if (model.model.trim().length === 0) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID} model ${id} has no configured model identity`,
    );
  }
  return { id: model.id, provider: model.provider, model: model.model };
}
