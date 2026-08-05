import { describe, expect, it } from 'vitest';
import {
  VALIDATION_EVIDENCE_GATE_IDS,
  ValidationEvidencePublicationRequestSchema,
} from './validation-evidence.js';

const reference = { runId: 'run-1' };
const environmentReadiness = {
  status: 'passed' as const,
  environmentId: 'environment-1',
  checks: [
    {
      boundary: 'docker' as const,
      status: 'passed' as const,
      durationMs: 1,
    },
  ],
};

function gates() {
  return VALIDATION_EVIDENCE_GATE_IDS.map((id) => ({
    id,
    status: 'passed' as const,
    references: [reference],
  }));
}

describe('validation evidence contracts', () => {
  it('accepts one bounded observation for every mandatory gate', () => {
    expect(
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: gates(),
      }),
    ).toMatchObject({ environmentReadiness, gates: gates() });
  });

  it('rejects missing or duplicate mandatory gates', () => {
    expect(() =>
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: gates().slice(1),
      }),
    ).toThrow(/exactly one observation/);

    expect(() =>
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: [...gates().slice(0, -1), gates()[0]],
      }),
    ).toThrow(/exactly one observation/);
  });

  it('requires references for passed gates and bounds summaries', () => {
    const missingReference = gates().map((gate, index) =>
      index === 0 ? { ...gate, references: [] } : gate,
    );
    expect(() =>
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: missingReference,
      }),
    ).toThrow(/reference/);

    expect(() =>
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: gates().map((gate, index) =>
          index === 0 ? { ...gate, summary: 'x'.repeat(501) } : gate,
        ),
      }),
    ).toThrow();
  });

  it('requires a failure class for every non-passed gate', () => {
    expect(() =>
      ValidationEvidencePublicationRequestSchema.parse({
        environmentReadiness,
        gates: gates().map((gate, index) =>
          index === 0 ? { ...gate, status: 'unavailable' as const } : gate,
        ),
      }),
    ).toThrow(/failure classification/);
  });
});
