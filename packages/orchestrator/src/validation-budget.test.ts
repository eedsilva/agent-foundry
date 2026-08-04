import { describe, expect, it } from 'vitest';
import {
  RouteDecisionSchema,
  type ModelDefinition,
  type StepAttempt,
  type TaskProfile,
} from '@agent-foundry/contracts';
import {
  estimateValidationDispatchCostUsd,
  summarizeValidationUsage,
  validationStepKey,
} from './validation-budget.js';

const profile = {
  role: 'developer',
  taskKind: 'implementation',
  complexity: 1,
  risk: 1,
  estimatedContextTokens: 1_000_000,
  estimatedOutputTokens: 1_000_000,
  mutatesWorkspace: true,
  toolPolicy: 'workspace-write',
  priorities: { quality: 1, speed: 0, cost: 0, reliability: 0 },
  features: [],
  taxonomyVersion: '1',
  category: 'implementation/general',
  preferredTags: [],
} satisfies TaskProfile;

const metered = {
  id: 'metered',
  provider: 'codex',
  model: 'metered-model',
  billingMode: 'metered',
  pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 3 },
  enabled: true,
  requireExplicitModel: false,
  canWriteWorkspace: true,
  tags: [],
  maxContextTokens: 2_000_000,
  capabilities: {
    planning: 1,
    architecture: 1,
    coding: 1,
    review: 1,
    repair: 1,
    structuredOutput: 1,
    speed: 1,
    costEfficiency: 1,
    reliability: 1,
  },
} satisfies ModelDefinition;
const subscription = {
  ...metered,
  id: 'subscription',
  billingMode: 'subscription',
} satisfies ModelDefinition;
const unknown = {
  ...metered,
  id: 'unknown',
  billingMode: 'unknown',
} satisfies ModelDefinition;

function attempt(id: string, usage?: StepAttempt['usage'], modelId = metered.id): StepAttempt {
  const model =
    modelId === metered.id ? metered : modelId === subscription.id ? subscription : unknown;
  return {
    id,
    runId: 'run-1',
    stepRunId: `step-${id}`,
    sequence: 1,
    executorKind: 'agent',
    provider: 'codex',
    model: model.model,
    modelId,
    status: 'succeeded',
    version: 1,
    createdAt: '2026-08-03T12:00:00.000Z',
    updatedAt: '2026-08-03T12:00:00.000Z',
    startedAt: '2026-08-03T12:00:00.000Z',
    usage,
    context: {
      projectId: 'project-1',
      workflowId: 'workflow-1',
      nodeId: 'node-1',
      stepId: 'step-1',
    },
    inputArtifacts: [],
    outputArtifacts: [],
  };
}

describe('validation campaign budget accounting', () => {
  it('keeps provider-reported, catalog-estimated, unknown, and subscription quota usage separate', () => {
    const summary = summarizeValidationUsage(
      [
        attempt('provider', { providerReportedCostUsd: 1.25, quotaUnits: 2 }),
        attempt('estimated', { estimatedCostUsd: 0.75, quotaUnits: 3 }),
        attempt('unknown'),
        attempt('unknown-reported', { providerReportedCostUsd: 0.5, quotaUnits: 1 }, unknown.id),
        attempt('subscription', { quotaUnits: 4 }, subscription.id),
      ],
      [metered, subscription, unknown],
    );

    expect(summary).toMatchObject({
      providerReportedCostUsd: 1.75,
      catalogEstimatedCostUsd: 0.75,
      meteredCostUsd: 2.5,
      unknownMeteredAttempts: 2,
      subscriptionQuotaUnits: 4,
      subscriptionQuotaUnitsByProvider: { codex: 4 },
    });
    expect(summary.attemptsByStep[validationStepKey('node-1', 'step-1')]).toBe(5);
  });

  it('estimates the next metered dispatch without inventing a value for unknown pricing', () => {
    expect(estimateValidationDispatchCostUsd(profile, metered)).toBe(4);
    expect(estimateValidationDispatchCostUsd(profile, subscription)).toBe(4);
    expect(estimateValidationDispatchCostUsd(profile, unknown)).toBeUndefined();
    expect(
      estimateValidationDispatchCostUsd(profile, { ...metered, pricing: undefined }),
    ).toBeUndefined();
  });

  it('does not attribute quota to an unrelated persisted route identity', () => {
    const persistedRoute = RouteDecisionSchema.parse({
      routeId: 'route-1',
      createdAt: '2026-08-03T12:00:00.000Z',
      profile,
      selected: { model: subscription },
      fallbacks: [],
      rejected: [],
    });
    const summary = summarizeValidationUsage(
      [
        {
          ...attempt('unmatched', { quotaUnits: 4 }, subscription.id),
          modelId: undefined,
          model: 'different-model',
          routeDecision: persistedRoute,
        },
      ],
      [subscription],
    );

    expect(summary.subscriptionQuotaUnits).toBe(0);
    expect(summary.unknownMeteredAttempts).toBe(1);
  });

  it('uses the persisted route identity when the current catalog no longer has the model id', () => {
    const persistedRoute = RouteDecisionSchema.parse({
      routeId: 'route-1',
      createdAt: '2026-08-03T12:00:00.000Z',
      profile,
      selected: { model: metered },
      fallbacks: [],
      rejected: [],
    });
    const summary = summarizeValidationUsage(
      [
        {
          ...attempt('removed', { providerReportedCostUsd: 1 }),
          modelId: 'removed-model',
          routeDecision: persistedRoute,
        },
      ],
      [],
    );

    expect(summary.providerReportedCostUsd).toBe(1);
    expect(summary.meteredCostUsd).toBe(1);
  });

  it('prefers the exact persisted route model id when provider tuples are duplicated', () => {
    const persistedRoute = RouteDecisionSchema.parse({
      routeId: 'route-1',
      createdAt: '2026-08-03T12:00:00.000Z',
      profile,
      selected: { model: subscription },
      fallbacks: [],
      rejected: [],
    });
    const summary = summarizeValidationUsage(
      [
        {
          ...attempt('duplicate', { quotaUnits: 4 }, subscription.id),
          routeDecision: persistedRoute,
        },
      ],
      [metered, subscription],
    );

    expect(summary.subscriptionQuotaUnits).toBe(4);
    expect(summary.meteredCostUsd).toBe(0);
  });
});
