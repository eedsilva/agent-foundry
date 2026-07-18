import { describe, expect, it } from 'vitest';
import { ModelMetricSchema } from './model.js';

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
