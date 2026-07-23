import {
  CalibrationReportSchema,
  type CalibrationReport,
  type ModelMetric,
} from '@agent-foundry/contracts';

const BUCKET_COUNT = 10;
// Nudge away from float dust at exact tenth boundaries (e.g. 0.3 * 10 === 2.9999999999999996).
const EPS = 1e-9;

function bucketIndex(predicted: number): number {
  return Math.min(BUCKET_COUNT - 1, Math.floor(predicted * BUCKET_COUNT + EPS));
}

export function buildCalibrationReport(metrics: ModelMetric[]): CalibrationReport {
  const evaluated = metrics.filter((metric) => metric.qualityEvaluations > 0);

  const buckets = new Map<
    number,
    { weightSum: number; predictedWeighted: number; observedWeighted: number }
  >();
  let totalSampleSize = 0;

  for (const metric of evaluated) {
    const predicted = (metric.qualityApprovals + 2) / (metric.qualityEvaluations + 4);
    const observed = metric.qualityApprovals / metric.qualityEvaluations;
    const weight = metric.qualityEvaluations;

    const index = bucketIndex(predicted);
    const bucket = buckets.get(index) ?? {
      weightSum: 0,
      predictedWeighted: 0,
      observedWeighted: 0,
    };
    bucket.weightSum += weight;
    bucket.predictedWeighted += predicted * weight;
    bucket.observedWeighted += observed * weight;
    buckets.set(index, bucket);

    totalSampleSize += weight;
  }

  const sortedIndexes = [...buckets.keys()].sort((a, b) => a - b);
  const reportBuckets = sortedIndexes.map((index) => {
    const bucket = buckets.get(index)!;
    return {
      lower: index / BUCKET_COUNT,
      upper: index === BUCKET_COUNT - 1 ? 1 : (index + 1) / BUCKET_COUNT,
      predictedMean: bucket.predictedWeighted / bucket.weightSum,
      observedApprovalRate: bucket.observedWeighted / bucket.weightSum,
      sampleSize: bucket.weightSum,
    };
  });

  const expectedCalibrationError =
    totalSampleSize === 0
      ? 0
      : reportBuckets.reduce(
          (total, bucket) =>
            total +
            (bucket.sampleSize / totalSampleSize) *
              Math.abs(bucket.predictedMean - bucket.observedApprovalRate),
          0,
        );

  return CalibrationReportSchema.parse({
    buckets: reportBuckets,
    expectedCalibrationError,
    sampleSize: totalSampleSize,
  });
}
