import { describe, expect, it } from 'vitest';
import type {
  ExecutorHealth,
  ModelDefinition,
  ModelMetric,
  TaskProfile,
} from '@agent-foundry/contracts';
import type { MetricsRepository } from '@agent-foundry/domain';
import { TableModelRouter } from './table-router.js';

class MemoryMetrics implements MetricsRepository {
  constructor(private readonly values = new Map<string, ModelMetric>()) {}
  async get(modelId: string, taskKind: string, role: string): Promise<ModelMetric | null> {
    return this.values.get(`${modelId}:${taskKind}:${role}`) ?? null;
  }
  async record(): Promise<void> {}
  async recordQuality(): Promise<void> {}
  async list(): Promise<ModelMetric[]> {
    return [...this.values.values()];
  }
}

const capabilities = {
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

function model(id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
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
    capabilities,
    ...overrides,
  };
}

/** Catalog order deliberately contradicts every table order under test. */
function catalog(): ModelDefinition[] {
  return [
    model('agy-default', { provider: 'agy' }),
    model('claude-opus', { provider: 'claude' }),
    model('claude-sonnet', { provider: 'claude' }),
    model('codex-default', { provider: 'codex' }),
  ];
}

function localModel(): ModelDefinition {
  return model('opencode-ollama', {
    provider: 'opencode',
    model: 'qwen2.5-coder:7b',
    billingMode: 'metered',
    pricing: {
      inputUsdPerMillionTokens: 0,
      outputUsdPerMillionTokens: 0,
    },
    tags: ['local', 'mechanical'],
  });
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

function router(models = catalog()): TableModelRouter {
  return new TableModelRouter(models, new MemoryMetrics());
}

describe('TableModelRouter', () => {
  it('can place OpenCode on the verification rung while keeping the table deterministic', async () => {
    const router = new TableModelRouter([localModel(), ...catalog()], new MemoryMetrics());
    const decision = await router.route({ ...profile, taskKind: 'verification' }, undefined, {
      routing: { source: 'web-app-v1', executors: ['opencode', 'codex'] },
    });

    expect(decision.selected.model.provider).toBe('opencode');
    expect(decision.routingTable).toMatchObject({
      source: 'web-app-v1',
      taskKind: 'verification',
      executors: ['opencode', 'codex'],
      selectedIndex: 0,
    });
  });

  it('selects GLM and records the constrained tier table in the route audit', async () => {
    const decision = await router([
      model('glm-fast', {
        provider: 'glm',
        model: 'GLM-4.5-Air',
        billingMode: 'metered',
        pricing: { inputUsdPerMillionTokens: 0.2, outputUsdPerMillionTokens: 1.1 },
      }),
    ]).route(profile, undefined, {
      routing: { source: 'cheap-tier', executors: ['glm'] },
    });

    expect(decision.selected.model.provider).toBe('glm');
    expect(decision.routingTable).toEqual({
      source: 'cheap-tier',
      taskKind: 'implementation',
      executors: ['glm'],
      selectedIndex: 0,
    });
  });

  it('selects the head of the table, not the head of the catalog', async () => {
    const decision = await router().route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['codex', 'claude', 'agy'] },
    });

    expect(decision.selected.model.id).toBe('codex-default');
    expect(decision.routingTable).toEqual({
      source: 'web-app-v1',
      taskKind: 'implementation',
      executors: ['codex', 'claude', 'agy'],
      selectedIndex: 0,
    });
    // No dimension scores are computed at all — there is nothing to fit them to.
    expect(decision.selected.score).toBeUndefined();
  });

  it('lets an opt-in campaign override the workflow routing table', async () => {
    const decision = await new TableModelRouter(
      [
        model('claude-haiku', { provider: 'claude', model: 'haiku' }),
        model('codex-default', { provider: 'codex', model: 'gpt-5.6-luna' }),
      ],
      new MemoryMetrics(),
      {
        routingOverride: {
          source: 'validation-campaign:real-todo-v1',
          table: [{ taskKind: 'implementation', executors: ['codex', 'claude'] }],
        },
      },
    ).route(profile, undefined, {
      routing: { source: 'workflow', executors: ['claude', 'codex'] },
    });

    expect(decision.selected.model.id).toBe('codex-default');
    expect(decision.fallbacks.map((candidate) => candidate.model.id)).toEqual(['claude-haiku']);
    expect(decision.routingTable).toMatchObject({
      source: 'validation-campaign:real-todo-v1',
      executors: ['codex', 'claude'],
      selectedIndex: 0,
    });
  });

  it('starts at the next table entry for a task retry', async () => {
    const decision = await router().route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['claude', 'codex', 'agy'] },
      routingStartIndex: 1,
    });

    expect(decision.selected.model.provider).toBe('codex');
    expect(decision.fallbacks.map((candidate) => candidate.model.provider)).toEqual(['agy']);
    expect(decision.routingTable).toMatchObject({
      executors: ['claude', 'codex', 'agy'],
      selectedIndex: 1,
    });
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        { modelId: 'claude-opus', reason: expect.stringContaining('already used') },
        { modelId: 'claude-sonnet', reason: expect.stringContaining('already used') },
      ]),
    );
  });

  it('orders fallbacks by the table and takes one model per executor', async () => {
    const decision = await router().route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['agy', 'claude', 'codex'] },
    });

    expect(decision.selected.model.id).toBe('agy-default');
    // `claude-opus` over `claude-sonnet` because the catalog lists it first: the
    // table picks the executor, the catalog's order picks its model.
    expect(decision.fallbacks.map((candidate) => candidate.model.id)).toEqual([
      'claude-opus',
      'codex-default',
    ]);
  });

  it('rejects an executor the table does not list, naming the table', async () => {
    const decision = await router().route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['codex'] },
    });

    expect(decision.selected.model.id).toBe('codex-default');
    expect(decision.fallbacks).toEqual([]);
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        { modelId: 'agy-default', reason: expect.stringContaining('web-app-v1') },
      ]),
    );
  });

  it('skips a table entry whose executor has no eligible model', async () => {
    // The only codex model cannot write, and the task mutates the workspace.
    const models = [model('codex-default', { provider: 'codex', canWriteWorkspace: false })].concat(
      catalog().filter((candidate) => candidate.provider !== 'codex'),
    );
    const decision = await router(models).route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['codex', 'claude'] },
    });

    expect(decision.selected.model.id).toBe('claude-opus');
    expect(decision.routingTable?.selectedIndex).toBe(1);
  });

  it('falls back to the engine table when the caller passes none', async () => {
    const decision = await router().route(profile);

    expect(decision.routingTable?.source).toBe('default');
    expect(decision.selected.model.provider).toBe('claude');
  });

  it('honours a pinned model over the table', async () => {
    const decision = await router().route(profile, {
      modelId: 'claude-sonnet',
      provider: 'claude',
      model: 'claude-sonnet',
    });

    expect(decision.selected.model.id).toBe('claude-sonnet');
    expect(decision.fallbacks).toEqual([]);
    // The pin is what decided, so no table entry is claimed for it.
    expect(decision.routingTable).toBeUndefined();
  });

  it('falls back to catalog order for a task kind no table covers', async () => {
    // `architecture` is retired, so no table names it. Throwing while eligible
    // models exist would be a worse answer than an unordered one.
    const decision = await router().route({ ...profile, taskKind: 'architecture' });

    expect(decision.selected.model.id).toBe('agy-default');
    expect(decision.routingTable).toBeUndefined();
  });

  it('rejects a subscription model that would outrun the quota left', async () => {
    const metrics = new MemoryMetrics(
      new Map([
        [
          'codex-default:implementation:developer',
          {
            modelId: 'codex-default',
            taskKind: 'implementation',
            role: 'developer',
            taxonomyVersion: '2',
            category: 'implementation/frontend',
            attempts: 4,
            successes: 4,
            consecutiveFailures: 0,
            totalDurationMs: 1_000,
            totalEstimatedCostUsd: 0,
            costKnownCount: 0,
            inputTokensKnownCount: 0,
            outputTokensKnownCount: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            qualityEvaluations: 0,
            qualityApprovals: 0,
            quotaUnitsTotal: 40,
            quotaUnitsKnownCount: 4,
            updatedAt: '2026-07-29T10:00:00.000Z',
          } as ModelMetric,
        ],
      ]),
    );
    const decision = await new TableModelRouter(catalog(), metrics).route(profile, undefined, {
      routing: { source: 'web-app-v1', executors: ['codex', 'claude'] },
      // 10 units per run on average, 3 left: the breaker stays shut at
      // non-zero remaining, so only this gate catches it.
      providerHealth: new Map<string, ExecutorHealth>([
        [
          'codex',
          { provider: 'codex', available: true, message: 'ok', rateLimit: { remaining: 3 } },
        ],
      ]),
    });

    expect(decision.selected.model.provider).toBe('claude');
    expect(decision.rejected).toEqual(
      expect.arrayContaining([
        { modelId: 'codex-default', reason: expect.stringContaining('over-quota') },
      ]),
    );
  });

  it('fails with the table in the message when nothing is eligible', async () => {
    await expect(
      router().route({ ...profile, allowedProviders: ['agy'] }, undefined, {
        routing: { source: 'web-app-v1', executors: ['codex'] },
      }),
    ).rejects.toThrow(/implementation/);
  });
});
