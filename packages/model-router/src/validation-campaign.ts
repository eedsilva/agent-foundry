import {
  ValidationCampaignPreviewSchema,
  type ModelDefinition,
  type ValidationModelIdentity,
  type ValidationCampaignPreview,
} from '@agent-foundry/contracts';

export const REAL_TODO_VALIDATION_CAMPAIGN_ID = 'real-todo-v1' as const;

const CLAUDE_HAIKU_MODEL_ID = 'claude-haiku';
// Dated identity, not the 'haiku' alias: the Claude CLI resolves aliases to
// their dated ID, and the campaign compares executed identity exactly — an
// alias here can never match what actually ran (#420). Boot with
// CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 (see OPERATIONS.md).
const CLAUDE_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CODEX_LUNA_MODEL_ID = 'codex-default';
const CODEX_LUNA_MODEL = 'gpt-5.6-luna';
const DEFAULT_ACTIVE_TIME_MINUTES = 60;

export function buildValidationCampaignPreview(
  models: readonly ModelDefinition[],
  sourceRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): ValidationCampaignPreview {
  const haiku = requireModel(models, CLAUDE_HAIKU_MODEL_ID, 'claude', CLAUDE_HAIKU_MODEL);
  const luna = requireModel(models, CODEX_LUNA_MODEL_ID, 'codex', CODEX_LUNA_MODEL);

  return ValidationCampaignPreviewSchema.parse({
    schemaVersion: '1',
    id: REAL_TODO_VALIDATION_CAMPAIGN_ID,
    name: 'Real TODO validation campaign',
    sourceRevision,
    allowedModels: [haiku, luna],
    routes: [
      // Route depth must cover the dispatch budget: repeated dispatches of the
      // same logical step advance the routing start index, so an empty
      // fallback list makes the third repair die on "no executor can satisfy"
      // instead of a clean budget stop (#436). Repeating the selected identity
      // keeps the catalog restricted while giving the budget room to act.
      { taskKind: 'planning', selected: haiku, fallbacks: [haiku] },
      { taskKind: 'implementation', selected: luna, fallbacks: [luna] },
      { taskKind: 'repair', selected: luna, fallbacks: [luna, luna] },
      { taskKind: 'verification', selected: haiku, fallbacks: [haiku] },
    ],
    limits: {
      // Operator decision 2026-08-06 (#426): cycles 10-12 each stopped on a
      // different single-shot model flake (guessed locator, non-surgical
      // repair, malformed artifact JSON) after infrastructure went solid for
      // five straight cycles. One retry per step absorbs output flakes; three
      // targeted repairs stop task-repair and browser-repair from competing
      // for the same slot. No metered ceiling — every campaign model is
      // subscription-billed (#439).
      attemptsPerAgentStep: 2,
      targetedRepairs: 3,
      activeTimeMinutes: resolveActiveTimeMinutes(env),
    },
  });
}

// The 60-minute cap above was sized for the single-shape TODO campaign; the
// four-shape golden journey (#564) does not fit inside it. The override lands
// in the preview rather than in a runner flag so every evidence bundle's
// campaign snapshot records the budget its run was actually given.
function resolveActiveTimeMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env.VALIDATION_ACTIVE_TIME_MINUTES?.trim();
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_ACTIVE_TIME_MINUTES;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `Validation campaign ${REAL_TODO_VALIDATION_CAMPAIGN_ID}: VALIDATION_ACTIVE_TIME_MINUTES must be a positive integer; found ${env.VALIDATION_ACTIVE_TIME_MINUTES}`,
    );
  }
  return Number(raw);
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
