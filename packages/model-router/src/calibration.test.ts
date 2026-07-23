import { describe, expect, it } from 'vitest';
import type { ModelMetric } from '@agent-foundry/contracts';
import { buildCalibrationReport } from './calibration.js';

function metric(overrides: {
  modelId: string;
  qualityApprovals: number;
  qualityEvaluations: number;
}): ModelMetric {
  return {
    modelId: overrides.modelId,
    taskKind: 'implementation',
    role: 'developer',
    taxonomyVersion: '1',
    category: 'implementation/general',
    attempts: 0,
    successes: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    consecutiveFailures: 0,
    qualityEvaluations: overrides.qualityEvaluations,
    qualityApprovals: overrides.qualityApprovals,
    updatedAt: '2026-07-18T12:00:00.000Z',
  };
}

describe('buildCalibrationReport', () => {
  it('returns the empty report for no metrics', () => {
    expect(buildCalibrationReport([])).toEqual({
      buckets: [],
      expectedCalibrationError: 0,
      sampleSize: 0,
    });
  });

  it('excludes metrics with zero quality evaluations', () => {
    const noEvaluations = metric({ modelId: 'm', qualityApprovals: 0, qualityEvaluations: 0 });
    expect(buildCalibrationReport([noEvaluations])).toEqual({
      buckets: [],
      expectedCalibrationError: 0,
      sampleSize: 0,
    });
  });

  it('produces a single well-calibrated bucket when predicted matches observed', () => {
    // predicted = (5+2)/(10+4) = 0.5; observed = 5/10 = 0.5 — exact match.
    const report = buildCalibrationReport([
      metric({ modelId: 'm', qualityApprovals: 5, qualityEvaluations: 10 }),
    ]);

    expect(report.buckets).toHaveLength(1);
    expect(report.buckets[0]).toEqual({
      lower: 0.5,
      upper: 0.6,
      predictedMean: 0.5,
      observedApprovalRate: 0.5,
      sampleSize: 10,
    });
    expect(report.expectedCalibrationError).toBeCloseTo(0, 5);
    expect(report.sampleSize).toBe(10);
  });

  it('keeps two metrics with very different predicted rates in separate buckets', () => {
    const low = metric({ modelId: 'low', qualityApprovals: 0, qualityEvaluations: 10 });
    const high = metric({ modelId: 'high', qualityApprovals: 10, qualityEvaluations: 10 });

    const report = buildCalibrationReport([low, high]);

    expect(report.buckets).toHaveLength(2);
    for (const bucket of report.buckets) {
      expect(bucket.sampleSize).toBe(10);
    }
    expect(report.sampleSize).toBe(20);
    // low: predicted (0+2)/14 ≈ 0.1429 → bucket [0.1, 0.2)
    // high: predicted (10+2)/14 ≈ 0.8571 → bucket [0.8, 0.9)
    const bucketBounds = report.buckets
      .map((b) => [b.lower, b.upper])
      .sort((a, b) => a[0]! - b[0]!);
    expect(bucketBounds).toEqual([
      [0.1, 0.2],
      [0.8, 0.9],
    ]);
  });

  it('weights predictedMean/observedApprovalRate within a shared bucket by sample size', () => {
    // Both fall in bucket [0.5, 0.6).
    // a: predicted (5+2)/(10+4) = 0.5, observed 5/10 = 0.5, weight 10.
    // b: predicted (50+2)/(90+4) = 52/94 ≈ 0.5531914894, observed 50/90 ≈ 0.5555555556, weight 90.
    const a = metric({ modelId: 'a', qualityApprovals: 5, qualityEvaluations: 10 });
    const b = metric({ modelId: 'b', qualityApprovals: 50, qualityEvaluations: 90 });

    const report = buildCalibrationReport([a, b]);

    expect(report.buckets).toHaveLength(1);
    const bucket = report.buckets[0]!;
    expect(bucket.sampleSize).toBe(100);

    // Weighted average, NOT the plain unweighted average of the two rates.
    const weightedPredicted = (0.5 * 10 + (52 / 94) * 90) / 100;
    const weightedObserved = (0.5 * 10 + (50 / 90) * 90) / 100;
    const unweightedPredicted = (0.5 + 52 / 94) / 2;

    expect(bucket.predictedMean).toBeCloseTo(weightedPredicted, 9);
    expect(bucket.observedApprovalRate).toBeCloseTo(weightedObserved, 9);
    expect(bucket.predictedMean).not.toBeCloseTo(unweightedPredicted, 3);
  });

  it('places predicted approaching 1 in the closed last bucket [0.9, 1.0], not off the end', () => {
    // predicted = (1000+2)/(1000+4) = 1002/1004 ≈ 0.998008 — well inside [0.9, 1.0].
    const report = buildCalibrationReport([
      metric({ modelId: 'm', qualityApprovals: 1000, qualityEvaluations: 1000 }),
    ]);

    expect(report.buckets).toHaveLength(1);
    const bucket = report.buckets[0]!;
    expect(bucket.lower).toBe(0.9);
    expect(bucket.upper).toBe(1);
    expect(bucket.predictedMean).toBeCloseTo(1002 / 1004, 9);
    expect(bucket.observedApprovalRate).toBe(1);
    expect(bucket.sampleSize).toBe(1000);
  });
});
