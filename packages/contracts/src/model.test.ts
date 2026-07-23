import { describe, expect, it } from 'vitest';
import { CalibrationReportSchema, ModelMetricSchema, RouteConfidenceSchema } from './model.js';

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

describe('RouteConfidenceSchema', () => {
  const valid = {
    value: 0.44,
    sampleSize: 4,
    interval: { lower: 0.2, upper: 0.8 },
    coldStart: true,
    rationale: '4 executions; prior weight 44% -> conservative',
  };

  it('accepts a well-formed confidence block', () => {
    expect(RouteConfidenceSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a value outside [0,1]', () => {
    expect(() => RouteConfidenceSchema.parse({ ...valid, value: 1.1 })).toThrow();
  });

  it('rejects a negative sampleSize', () => {
    expect(() => RouteConfidenceSchema.parse({ ...valid, sampleSize: -1 })).toThrow();
  });

  it('rejects an interval bound outside [0,1]', () => {
    expect(() =>
      RouteConfidenceSchema.parse({ ...valid, interval: { lower: -0.1, upper: 0.8 } }),
    ).toThrow();
  });

  it('rejects an empty rationale', () => {
    expect(() => RouteConfidenceSchema.parse({ ...valid, rationale: '' })).toThrow();
  });

  it('rejects unknown extra fields', () => {
    expect(() => RouteConfidenceSchema.parse({ ...valid, extra: 'nope' })).toThrow();
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
