import { describe, expect, it } from 'vitest';
import type { ModelDefinition, ModelMetric, TaskProfile } from '@agent-foundry/contracts';
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
});
