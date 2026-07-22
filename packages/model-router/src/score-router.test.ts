import { describe, expect, it } from 'vitest';
import type {
  ModelDefinition,
  ModelMetric,
  QualityObservation,
  RouteOverrideProvenance,
  TaskProfile,
} from '@agent-foundry/contracts';
import type { MetricsRepository, QualityObservationRepository } from '@agent-foundry/domain';
import { ScoreBasedModelRouter } from './score-router.js';

class MemoryMetrics implements MetricsRepository {
  readonly requestedCategories: Array<string | undefined> = [];
  constructor(private readonly values = new Map<string, ModelMetric>()) {}
  async get(
    modelId: string,
    taskKind: string,
    role: string,
    category?: string,
  ): Promise<ModelMetric | null> {
    this.requestedCategories.push(category);
    return this.values.get(`${modelId}:${taskKind}:${role}`) ?? null;
  }
  async record(): Promise<void> {}
  async recordQuality(): Promise<void> {}
}

class MemoryQualityObservations implements QualityObservationRepository {
  constructor(private readonly values: QualityObservation[]) {}
  async record(): Promise<void> {}
  async list(
    query: Parameters<QualityObservationRepository['list']>[0],
  ): Promise<QualityObservation[]> {
    return this.values.filter(
      (item) =>
        item.subject.modelId === query.modelId &&
        item.subject.taskKind === query.taskKind &&
        item.subject.role === query.role &&
        item.subject.taxonomyVersion === query.taxonomyVersion &&
        item.subject.category === query.category,
    );
  }
}

const baseCapabilities = {
  planning: 0.5,
  architecture: 0.5,
  coding: 0.5,
  review: 0.5,
  repair: 0.5,
  structuredOutput: 0.8,
  speed: 0.5,
  costEfficiency: 0.5,
  reliability: 0.8,
};

function model(id: string, overrides: Partial<ModelDefinition>): ModelDefinition {
  return {
    id,
    provider: 'claude',
    model: id,
    billingMode: 'subscription',
    enabled: true,
    requireExplicitModel: false,
    maxContextTokens: 100_000,
    canWriteWorkspace: true,
    tags: [],
    capabilities: baseCapabilities,
    ...overrides,
  };
}

const profile: TaskProfile = {
  role: 'developer',
  taskKind: 'implementation',
  taxonomyVersion: '2',
  category: 'implementation/frontend',
  features: ['frontend'],
  complexity: 4,
  risk: 4,
  estimatedContextTokens: 20_000,
  estimatedOutputTokens: 8_000,
  mutatesWorkspace: true,
  toolPolicy: 'workspace-write',
  priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
  preferredTags: ['coding'],
};

function twoProviderCatalog(): ModelDefinition[] {
  return [
    model('claude-metered', {
      provider: 'claude',
      billingMode: 'metered',
      pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
    }),
    model('codex-subscription', {
      provider: 'codex',
      billingMode: 'subscription',
    }),
  ];
}

function quotaMetric({
  attempts = 1,
  quotaUnitsTotal,
  quotaUnitsKnownCount,
}: {
  attempts?: number;
  quotaUnitsTotal: number;
  quotaUnitsKnownCount: number;
}): ModelMetric {
  return {
    modelId: 'quota-heavy',
    taskKind: 'implementation',
    role: 'developer',
    taxonomyVersion: '2',
    category: 'implementation/frontend',
    attempts,
    successes: attempts,
    totalDurationMs: 1_000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    quotaUnitsTotal,
    quotaUnitsKnownCount,
    consecutiveFailures: 0,
    qualityEvaluations: 0,
    qualityApprovals: 0,
    updatedAt: new Date().toISOString(),
  };
}

const override: RouteOverrideProvenance = {
  source: 'run',
  overrideId: 'override-1',
  modelId: 'pinned',
  provider: 'codex',
  model: 'gpt-5',
  actor: { kind: 'user', id: 'ed' },
  reason: 'Use the verified model',
  estimatedImpact: 'More reliable output',
  createdAt: '2026-07-16T12:00:00.000Z',
};

function qualityObservation(
  modelId: string,
  source: QualityObservation['source'],
  score: number,
): QualityObservation {
  const evaluator =
    source === 'deterministic'
      ? { kind: 'deterministic' as const, id: 'workspace-verifier' }
      : { kind: 'llm' as const, id: 'reviewer-1' };
  return {
    id: `${modelId}-${source}`,
    source,
    subject: {
      modelId,
      taskKind: profile.taskKind,
      role: profile.role,
      taxonomyVersion: profile.taxonomyVersion,
      category: profile.category,
      artifact: { name: 'implementation', revision: 1, sha256: 'a'.repeat(64) },
    },
    evaluator,
    blind: source === 'blind-review',
    rubric: source,
    score,
    evidence: [
      {
        kind: source === 'deterministic' ? 'verification-report' : 'review-artifact',
        summary: source,
      },
    ],
    observedAt: '2026-07-18T12:00:00.000Z',
  };
}

describe('ScoreBasedModelRouter', () => {
  it('weights deterministic checks separately from blind reviews', async () => {
    const router = new ScoreBasedModelRouter(
      [model('verified', { tags: ['coding'] }), model('reviewed', { tags: ['coding'] })],
      new MemoryMetrics(),
      new MemoryQualityObservations([
        qualityObservation('verified', 'deterministic', 1),
        qualityObservation('verified', 'blind-review', 0),
        qualityObservation('reviewed', 'deterministic', 0),
        qualityObservation('reviewed', 'blind-review', 1),
      ]),
    );

    const route = await router.route(profile);

    expect(route.selected.model.id).toBe('verified');
    expect(route.selected.quality).toMatchObject({
      components: { deterministic: { average: 1 }, blindReview: { average: 0 } },
      aggregate: 2 / 3,
    });
  });

  it('selects the stronger coding model for a quality-weighted implementation task', async () => {
    const metrics = new MemoryMetrics();
    const router = new ScoreBasedModelRouter(
      [
        model('fast', {
          tags: ['fast'],
          capabilities: { ...baseCapabilities, coding: 0.7, speed: 0.98 },
        }),
        model('strong', {
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.96, speed: 0.55 },
        }),
      ],
      metrics,
    );

    const route = await router.route(profile);
    expect(route.selected.model.id).toBe('strong');
    expect(route.fallbacks[0]?.model.id).toBe('fast');
    expect(metrics.requestedCategories).toEqual([
      'implementation/frontend',
      'implementation/frontend',
    ]);
  });

  it('uses reviewer outcomes to overcome a small prior advantage', async () => {
    const now = new Date().toISOString();
    const values = new Map<string, ModelMetric>([
      [
        'prior-favorite:implementation:developer',
        {
          modelId: 'prior-favorite',
          taskKind: 'implementation',
          role: 'developer',
          taxonomyVersion: '2',
          category: 'implementation/frontend',
          attempts: 20,
          successes: 20,
          totalDurationMs: 20_000,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalEstimatedCostUsd: 0,
          consecutiveFailures: 0,
          qualityEvaluations: 20,
          qualityApprovals: 0,
          updatedAt: now,
        },
      ],
      [
        'proven:implementation:developer',
        {
          modelId: 'proven',
          taskKind: 'implementation',
          role: 'developer',
          taxonomyVersion: '2',
          category: 'implementation/frontend',
          attempts: 20,
          successes: 20,
          totalDurationMs: 20_000,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalEstimatedCostUsd: 0,
          consecutiveFailures: 0,
          qualityEvaluations: 20,
          qualityApprovals: 20,
          updatedAt: now,
        },
      ],
    ]);
    const router = new ScoreBasedModelRouter(
      [
        model('prior-favorite', {
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.86 },
        }),
        model('proven', {
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.82 },
        }),
      ],
      new MemoryMetrics(values),
    );

    const route = await router.route(profile);
    expect(route.selected.model.id).toBe('proven');
    expect(route.selected.score.historical).toBeGreaterThan(
      route.fallbacks[0]?.score.historical ?? 0,
    );
  });

  it('diversifies early fallbacks across providers', async () => {
    const router = new ScoreBasedModelRouter(
      [
        model('claude-best', {
          provider: 'claude',
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.96 },
        }),
        model('claude-second', {
          provider: 'claude',
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.94 },
        }),
        model('claude-third', {
          provider: 'claude',
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.92 },
        }),
        model('codex-backup', {
          provider: 'codex',
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.88 },
        }),
        model('agy-backup', {
          provider: 'agy',
          tags: ['coding'],
          capabilities: { ...baseCapabilities, coding: 0.84 },
        }),
      ],
      new MemoryMetrics(),
    );

    const route = await router.route(profile);
    expect(route.selected.model.id).toBe('claude-best');
    expect(route.fallbacks.slice(0, 2).map((candidate) => candidate.model.provider)).toEqual([
      'codex',
      'agy',
    ]);
  });

  it('rejects providers forbidden by policy with an auditable reason', async () => {
    const router = new ScoreBasedModelRouter(
      [model('claude-model', { provider: 'claude' }), model('codex-model', { provider: 'codex' })],
      new MemoryMetrics(),
    );

    const route = await router.route({
      ...profile,
      policy: { id: 'strict', version: 2, allowedProviders: ['codex'] },
    });
    expect(route.selected.model.id).toBe('codex-model');
    expect(route.rejected).toEqual([
      {
        modelId: 'claude-model',
        reason: 'provider claude is forbidden by policy strict@v2',
      },
    ]);
  });

  it('throws when policy forbids every provider', async () => {
    const router = new ScoreBasedModelRouter(
      [model('claude-model', { provider: 'claude' })],
      new MemoryMetrics(),
    );

    await expect(
      router.route({
        ...profile,
        policy: { id: 'strict', version: 2, allowedProviders: ['codex'] },
      }),
    ).rejects.toThrow(/forbidden by policy strict@v2/);
  });

  it('rejects models whose context window is too small', async () => {
    const router = new ScoreBasedModelRouter(
      [model('small', { maxContextTokens: 1_000 }), model('large', { maxContextTokens: 100_000 })],
      new MemoryMetrics(),
    );

    const route = await router.route(profile);
    expect(route.selected.model.id).toBe('large');
    expect(route.rejected).toEqual([
      expect.objectContaining({ modelId: 'small', reason: expect.stringContaining('context') }),
    ]);
  });

  it('routes an explicit model as the only candidate and retains its provenance', async () => {
    const router = new ScoreBasedModelRouter(
      [
        model('automatic', { provider: 'claude' }),
        model('pinned', { provider: 'codex', model: 'gpt-5' }),
      ],
      new MemoryMetrics(),
    );

    const route = await router.route(profile, {
      modelId: 'pinned',
      provider: 'codex',
      model: 'gpt-5',
      provenance: override,
    });

    expect(route.selected.model.id).toBe('pinned');
    expect(route.fallbacks).toEqual([]);
    expect(route.override).toEqual(override);
  });

  it('fails closed when a pinned catalog id now resolves to a different tuple', async () => {
    const router = new ScoreBasedModelRouter(
      [model('pinned', { provider: 'codex', model: 'gpt-5.1' })],
      new MemoryMetrics(),
    );

    await expect(
      router.route(profile, {
        modelId: 'pinned',
        provider: 'codex',
        model: 'gpt-5',
        provenance: override,
      }),
    ).rejects.toThrow(/catalog tuple changed.*codex\/gpt-5.*codex\/gpt-5.1/);
  });

  it.each([
    [
      'project policy',
      { policy: { id: 'strict', version: 1, allowedProviders: ['claude'] as const } },
      /forbidden by policy/,
    ],
    ['step provider', { allowedProviders: ['claude'] as const }, /not allowed/],
    ['context capacity', { estimatedContextTokens: 200_000 }, /context/],
    ['workspace writes', { mutatesWorkspace: true }, /cannot mutate/],
  ])('rejects an explicit model that violates %s constraints', async (_label, change, message) => {
    const pinned = model('pinned', {
      provider: 'codex',
      model: 'gpt-5',
      maxContextTokens: 100_000,
      canWriteWorkspace: false,
    });
    const router = new ScoreBasedModelRouter([pinned], new MemoryMetrics());
    const constrainedProfile = {
      ...profile,
      mutatesWorkspace: false,
      estimatedContextTokens: 20_000,
      ...change,
    } as TaskProfile;

    await expect(
      router.route(constrainedProfile, {
        modelId: 'pinned',
        provider: 'codex',
        model: 'gpt-5',
        provenance: override,
      }),
    ).rejects.toThrow(message);
  });

  it('excludes a model whose provider is rate-limited until a future reset', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const health = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { remaining: 0, resetAt: '2999-01-01T00:00:00.000Z' },
        },
      ],
    ]);
    const decision = await router.route(profile, undefined, { providerHealth: health });
    expect(decision.selected.model.provider).not.toBe('claude');
    expect(decision.rejected.some((r) => r.reason.startsWith('rate-limited'))).toBe(true);
  });

  it('excludes a model when its provider reports only a future rate-limit reset', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const health = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { resetAt: '2999-01-01T00:00:00.000Z' },
        },
      ],
    ]);

    const decision = await router.route(profile, undefined, { providerHealth: health });

    expect(decision.selected.model.provider).not.toBe('claude');
    expect(decision.rejected).toContainEqual({
      modelId: 'claude-metered',
      reason: 'rate-limited until 2999-01-01T00:00:00.000Z',
    });
  });

  it('keeps a model routable when its provider reports positive remaining quota', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const health = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { remaining: 1, resetAt: '2999-01-01T00:00:00.000Z' },
        },
      ],
    ]);

    const decision = await router.route(profile, undefined, { providerHealth: health });

    expect(
      [decision.selected, ...decision.fallbacks].map((candidate) => candidate.model.id),
    ).toContain('claude-metered');
    expect(decision.rejected).not.toContainEqual({
      modelId: 'claude-metered',
      reason: 'rate-limited until 2999-01-01T00:00:00.000Z',
    });
  });

  it('rejects a metered model that exceeds the cost budget', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const decision = await router.route(profile, undefined, {
      budget: { maxCostUsd: 0 },
    });
    // every metered model estimates > $0 → rejected; a subscription/no-pricing model may remain
    expect(decision.rejected.some((r) => r.reason.startsWith('over-budget'))).toBe(true);
  });

  it('rejects a subscription model whose observed quota use exceeds the remaining budget', async () => {
    const metric = quotaMetric({
      attempts: 2,
      quotaUnitsTotal: 4,
      quotaUnitsKnownCount: 2,
    });
    const router = new ScoreBasedModelRouter(
      [model('quota-heavy', {}), model('metered-fallback', { billingMode: 'metered' })],
      new MemoryMetrics(new Map([['quota-heavy:implementation:developer', metric]])),
    );

    const decision = await router.route(profile, undefined, { budget: { maxQuotaUnits: 1 } });

    expect(decision.rejected).toContainEqual({
      modelId: 'quota-heavy',
      reason: 'over-budget: est 2 quota units > 1',
    });
  });

  it('uses provider-reported remaining units as the subscription quota budget', async () => {
    const metric = quotaMetric({
      quotaUnitsTotal: 2,
      quotaUnitsKnownCount: 1,
    });
    const router = new ScoreBasedModelRouter(
      [model('quota-heavy', {}), model('metered-fallback', { billingMode: 'metered' })],
      new MemoryMetrics(new Map([['quota-heavy:implementation:developer', metric]])),
    );
    const providerHealth = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { remaining: 1 },
        },
      ],
    ]);

    const decision = await router.route(profile, undefined, { providerHealth });

    expect(decision.rejected).toContainEqual({
      modelId: 'quota-heavy',
      reason: 'over-budget: est 2 quota units > 1',
    });
  });

  it('ignores provider-reported remaining units after the rate-limit reset', async () => {
    const metric = quotaMetric({
      quotaUnitsTotal: 2,
      quotaUnitsKnownCount: 1,
    });
    const router = new ScoreBasedModelRouter(
      [model('quota-heavy', {}), model('metered-fallback', { billingMode: 'metered' })],
      new MemoryMetrics(new Map([['quota-heavy:implementation:developer', metric]])),
    );
    const providerHealth = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { remaining: 1, resetAt: '2000-01-01T00:00:00.000Z' },
        },
      ],
    ]);

    const decision = await router.route(profile, undefined, { providerHealth });

    expect(decision.rejected).not.toContainEqual({
      modelId: 'quota-heavy',
      reason: 'over-budget: est 2 quota units > 1',
    });
  });

  it('does not treat attempts without reported cost as zero-cost history', async () => {
    const now = new Date().toISOString();
    const metrics = new MemoryMetrics(
      new Map([
        [
          'partially-priced:implementation:developer',
          {
            modelId: 'partially-priced',
            taskKind: 'implementation',
            role: 'developer',
            taxonomyVersion: '2',
            category: 'implementation/frontend',
            attempts: 10,
            successes: 10,
            totalDurationMs: 1_000,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalEstimatedCostUsd: 2,
            costKnownCount: 2,
            consecutiveFailures: 0,
            qualityEvaluations: 0,
            qualityApprovals: 0,
            updatedAt: now,
          },
        ],
      ]),
    );
    const router = new ScoreBasedModelRouter(
      [
        model('partially-priced', {
          billingMode: 'metered',
          pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
        }),
        model('subscription-fallback', { provider: 'codex' }),
      ],
      metrics,
    );

    const decision = await router.route(profile, undefined, { budget: { maxCostUsd: 0.5 } });

    expect(decision.rejected).toContainEqual({
      modelId: 'partially-priced',
      reason: 'over-budget: est $1.0000 > $0.5',
    });
  });

  it('ignores absent constraints (unchanged behavior)', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const a = await router.route(profile);
    const b = await router.route(profile, undefined, {});
    expect(b.selected.model.id).toBe(a.selected.model.id);
  });
});
