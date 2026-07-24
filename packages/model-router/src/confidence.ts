import {
  RouteConfidenceSchema,
  type ModelMetric,
  type QualitySignalSummary,
  type RouteConfidence,
} from '@agent-foundry/contracts';
import { clamp } from './clamp.js';

/** Matches the Laplace `+4` denominator used by score-router's score() method. */
export const PRIOR_PSEUDO_COUNT = 4;

export function effectiveSampleSize(
  metric: ModelMetric | null,
  quality?: QualitySignalSummary,
): number {
  return (
    (metric?.attempts ?? 0) +
    Math.max(metric?.qualityEvaluations ?? 0, quality?.observations.length ?? 0)
  );
}

export function routeConfidence(
  metric: ModelMetric | null,
  quality: QualitySignalSummary | undefined,
  historicalScore: number,
): RouteConfidence {
  const n = effectiveSampleSize(metric, quality);
  const value = n / (n + PRIOR_PSEUDO_COUNT);
  const coldStart = n < PRIOR_PSEUDO_COUNT;

  return RouteConfidenceSchema.parse({
    value,
    sampleSize: n,
    interval: wilsonInterval(historicalScore, n),
    coldStart,
    rationale: `${n} observations; prior weight ${Math.round((1 - value) * 100)}%${
      coldStart ? ' (cold start — conservative)' : ''
    }`,
  });
}

/** 95% Wilson score interval for a binomial proportion at sample size n. */
function wilsonInterval(historicalScore: number, n: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const z = 1.96;
  const denom = 1 + (z * z) / n;
  const center = (historicalScore + (z * z) / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((historicalScore * (1 - historicalScore)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: clamp(center - margin), upper: clamp(center + margin) };
}
