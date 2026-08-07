import { describe, expect, it } from 'vitest';
import { CalibrationReportSchema, ModelMetricSchema, RouteDecisionSchema } from './model.js';

describe('ModelMetricSchema known counts', () => {
  const base = {
    modelId: 'm',
    taskKind: 'implementation',
    role: 'developer',
    attempts: 1,
    successes: 1,
    totalDurationMs: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    consecutiveFailures: 0,
    updatedAt: '2026-07-18T12:00:00.000Z',
  };

  it('defaults known counts and quota total to undefined (unknown, not zero)', () => {
    const metric = ModelMetricSchema.parse(base);
    expect(metric.inputTokensKnownCount).toBeUndefined();
    expect(metric.quotaUnitsTotal).toBeUndefined();
  });

  it('accepts explicit known counts and quota total', () => {
    const metric = ModelMetricSchema.parse({
      ...base,
      quotaUnitsTotal: 5,
      inputTokensKnownCount: 1,
      quotaUnitsKnownCount: 1,
    });
    expect(metric.quotaUnitsTotal).toBe(5);
    expect(metric.inputTokensKnownCount).toBe(1);
  });
});

describe('CalibrationReportSchema', () => {
  const valid = {
    buckets: [
      { lower: 0.4, upper: 0.5, predictedMean: 0.44, observedApprovalRate: 0.5, sampleSize: 10 },
    ],
    expectedCalibrationError: 0.06,
    sampleSize: 10,
  };

  it('accepts a well-formed calibration report', () => {
    expect(CalibrationReportSchema.parse(valid)).toEqual(valid);
  });

  it('accepts an empty report with zero buckets', () => {
    const empty = { buckets: [], expectedCalibrationError: 0, sampleSize: 0 };
    expect(CalibrationReportSchema.parse(empty)).toEqual(empty);
  });

  it('rejects an expectedCalibrationError outside [0,1]', () => {
    expect(() =>
      CalibrationReportSchema.parse({ ...valid, expectedCalibrationError: 1.5 }),
    ).toThrow();
  });

  it('rejects a bucket sampleSize that is not a non-negative integer', () => {
    expect(() =>
      CalibrationReportSchema.parse({
        ...valid,
        buckets: [{ ...valid.buckets[0], sampleSize: -1 }],
      }),
    ).toThrow();
  });
});

describe('RouteDecisionSchema legacy fields (#358)', () => {
  const base = {
    routeId: 'route-1',
    createdAt: '2026-07-16T12:00:00.000Z',
    profile: {
      role: 'developer' as const,
      taskKind: 'implementation' as const,
      complexity: 3,
      risk: 3,
      estimatedContextTokens: 1_000,
      estimatedOutputTokens: 500,
      mutatesWorkspace: true,
    },
    selected: {
      model: {
        id: 'codex-gpt-5',
        provider: 'codex' as const,
        model: 'gpt-5',
        maxContextTokens: 100_000,
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
      },
      score: {
        capability: 1,
        context: 1,
        speed: 1,
        cost: 1,
        reliability: 1,
        historical: 1,
        tagAffinity: 1,
        estimatedCostUsd: null,
        total: 1,
      },
    },
    fallbacks: [],
    rejected: [],
  };

  it('parses a current RouteDecision', () => {
    expect(() => RouteDecisionSchema.parse(base)).not.toThrow();
  });

  it('strips legacy keys persisted before #358 (exploration, priorities, quality, confidence, billingMode)', () => {
    const route = RouteDecisionSchema.parse({
      ...base,
      profile: {
        ...base.profile,
        priorities: { quality: 1, speed: 0, cost: 0, reliability: 0 },
      },
      selected: {
        ...base.selected,
        model: { ...base.selected.model, billingMode: 'metered' },
        quality: { some: 'legacy' },
        confidence: { value: 0.5 },
      },
      exploration: {
        explored: true,
        rate: 0.1,
        reason: 'Epsilon-greedy exploration',
      },
    });
    expect(route).not.toHaveProperty('exploration');
    expect(route.profile).not.toHaveProperty('priorities');
    expect(route.selected).not.toHaveProperty('quality');
    expect(route.selected).not.toHaveProperty('confidence');
    expect(route.selected.model).not.toHaveProperty('billingMode');
  });
});
