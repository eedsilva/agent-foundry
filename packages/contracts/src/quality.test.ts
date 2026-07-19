import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import { QualityObservationSchema } from './quality.js';

const subject = {
  modelId: 'model-1',
  taskKind: 'implementation' as const,
  role: 'developer' as const,
  taxonomyVersion: '2' as const,
  category: 'implementation/backend' as const,
  artifact: { name: 'implementation', revision: 1, sha256: 'a'.repeat(64) },
};

describe('quality observation contracts', () => {
  it('exports the versioned quality observation schema', () => {
    expect('QualityObservationSchema' in contracts).toBe(true);
  });

  it('preserves evaluator, blind flag, rubric, score, and evidence', () => {
    expect(
      QualityObservationSchema.parse({
        id: 'quality-1',
        source: 'blind-review',
        subject,
        evaluator: { kind: 'llm', id: 'reviewer-1' },
        blind: true,
        rubric: 'workflow-review',
        score: 0.75,
        evidence: [
          {
            kind: 'review-artifact',
            artifact: { name: 'review', revision: 1, sha256: 'b'.repeat(64) },
            summary: 'Approved with one suggestion.',
          },
        ],
        observedAt: '2026-07-18T12:00:00.000Z',
      }),
    ).toMatchObject({ source: 'blind-review', blind: true, subject });
  });

  it('rejects a blind review that identifies itself as a human evaluator', () => {
    expect(() =>
      QualityObservationSchema.parse({
        id: 'quality-1',
        source: 'blind-review',
        subject,
        evaluator: { kind: 'human', id: 'ed' },
        blind: true,
        rubric: 'workflow-review',
        score: 0.75,
        evidence: [{ kind: 'review-artifact', summary: 'Approved.' }],
        observedAt: '2026-07-18T12:00:00.000Z',
      }),
    ).toThrow(/llm evaluator/);
  });
});
