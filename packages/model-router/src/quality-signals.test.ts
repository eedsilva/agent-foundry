import { describe, expect, it } from 'vitest';
import * as modelRouter from './index.js';
import type { QualityObservation } from '@agent-foundry/contracts';
import { summarizeQualityObservations } from './quality-signals.js';

function observation(source: QualityObservation['source'], score: number): QualityObservation {
  const evaluator =
    source === 'deterministic'
      ? { kind: 'deterministic' as const, id: 'workspace-verifier' }
      : source === 'blind-review'
        ? { kind: 'llm' as const, id: 'reviewer-1' }
        : source === 'human-edit'
          ? { kind: 'human' as const, id: 'ed' }
          : { kind: 'system' as const, id: 'merge-monitor' };
  const evidenceKind =
    source === 'deterministic'
      ? 'verification-report'
      : source === 'blind-review'
        ? 'review-artifact'
        : source === 'human-edit'
          ? 'human-edit'
          : 'regression';
  return {
    id: `quality-${source}`,
    source,
    subject: {
      modelId: 'model-1',
      taskKind: 'implementation',
      role: 'developer',
      taxonomyVersion: '2',
      category: 'implementation/backend',
      artifact: { name: 'implementation', revision: 1, sha256: 'a'.repeat(64) },
    },
    evaluator,
    blind: source === 'blind-review',
    rubric: source,
    score,
    evidence: [{ kind: evidenceKind, summary: source }],
    observedAt: '2026-07-18T12:00:00.000Z',
  };
}

describe('quality signals', () => {
  it('exports the quality observation summarizer', () => {
    expect('summarizeQualityObservations' in modelRouter).toBe(true);
  });

  it('keeps source components and raw observations when calculating an aggregate', () => {
    const observations = [
      observation('deterministic', 1),
      observation('blind-review', 0.2),
      observation('human-edit', 0.4),
      observation('post-merge-regression', 0),
    ];

    const summary = summarizeQualityObservations(observations);

    expect(summary.components).toEqual({
      deterministic: { count: 1, average: 1 },
      blindReview: { count: 1, average: 0.2 },
      humanEdit: { count: 1, average: 0.4 },
      postMergeRegression: { count: 1, average: 0 },
    });
    expect(summary.aggregate).toBeCloseTo(0.61);
    expect(summary.observations).toEqual(observations);
  });

  it('normalizes weights across only the sources that exist', () => {
    const summary = summarizeQualityObservations([
      observation('blind-review', 0.8),
      observation('human-edit', 0.4),
    ]);

    expect(summary.aggregate).toBeCloseTo(0.65);
  });
});
