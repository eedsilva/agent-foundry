import {
  QualitySignalSummarySchema,
  type QualityObservation,
  type QualitySignalSummary,
} from '@agent-foundry/contracts';

export const QUALITY_SOURCE_WEIGHTS = {
  deterministic: 0.5,
  'blind-review': 0.25,
  'human-edit': 0.15,
  'post-merge-regression': 0.1,
} as const;

export function summarizeQualityObservations(
  observations: QualityObservation[],
): QualitySignalSummary {
  const components: QualitySignalSummary['components'] = {};
  const deterministic = component(observations, 'deterministic');
  const blindReview = component(observations, 'blind-review');
  const humanEdit = component(observations, 'human-edit');
  const postMergeRegression = component(observations, 'post-merge-regression');

  if (deterministic) components.deterministic = deterministic;
  if (blindReview) components.blindReview = blindReview;
  if (humanEdit) components.humanEdit = humanEdit;
  if (postMergeRegression) components.postMergeRegression = postMergeRegression;

  const weighted = [
    [QUALITY_SOURCE_WEIGHTS.deterministic, deterministic],
    [QUALITY_SOURCE_WEIGHTS['blind-review'], blindReview],
    [QUALITY_SOURCE_WEIGHTS['human-edit'], humanEdit],
    [QUALITY_SOURCE_WEIGHTS['post-merge-regression'], postMergeRegression],
  ] as const;
  const totalWeight = weighted.reduce((total, [weight, value]) => total + (value ? weight : 0), 0);
  const aggregate = totalWeight
    ? weighted.reduce((total, [weight, value]) => total + (value ? weight * value.average : 0), 0) /
      totalWeight
    : undefined;

  return QualitySignalSummarySchema.parse({
    observations,
    components,
    ...(aggregate === undefined ? {} : { aggregate }),
  });
}

function component(
  observations: QualityObservation[],
  source: QualityObservation['source'],
): { count: number; average: number } | undefined {
  const scores = observations.filter((observation) => observation.source === source);
  if (scores.length === 0) return undefined;
  return {
    count: scores.length,
    average: scores.reduce((total, observation) => total + observation.score, 0) / scores.length,
  };
}
