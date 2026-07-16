import { describe, expect, it } from 'vitest';
import type {
  ModelDefinition,
  ModelMetric,
  RouteOverrideProvenance,
  TaskProfile,
} from '@agent-foundry/contracts';
import type { MetricsRepository } from '@agent-foundry/domain';
import { ScoreBasedModelRouter } from './score-router.js';

class MemoryMetrics implements MetricsRepository {
  constructor(private readonly values = new Map<string, ModelMetric>()) {}
  async get(modelId: string, taskKind: string, role: string): Promise<ModelMetric | null> {
    return this.values.get(`${modelId}:${taskKind}:${role}`) ?? null;
  }
  async record(): Promise<void> {}
  async recordQuality(): Promise<void> {}
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
  complexity: 4,
  risk: 4,
  estimatedContextTokens: 20_000,
  estimatedOutputTokens: 8_000,
  mutatesWorkspace: true,
  priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
  preferredTags: ['coding'],
};

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

describe('ScoreBasedModelRouter', () => {
  it('selects the stronger coding model for a quality-weighted implementation task', async () => {
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
      new MemoryMetrics(),
    );

    const route = await router.route(profile);
    expect(route.selected.model.id).toBe('strong');
    expect(route.fallbacks[0]?.model.id).toBe('fast');
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

    const route = await router.route(profile, { modelId: 'pinned', provenance: override });

    expect(route.selected.model.id).toBe('pinned');
    expect(route.fallbacks).toEqual([]);
    expect(route.override).toEqual(override);
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
      router.route(constrainedProfile, { modelId: 'pinned', provenance: override }),
    ).rejects.toThrow(message);
  });
});
