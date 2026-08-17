import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ValidationEvidenceBundleSchema,
  VALIDATION_EVIDENCE_GATE_IDS,
  type ValidationEvidenceBundle,
  type ValidationEvidenceGate,
  type StoredArtifact,
} from '@agent-foundry/contracts';
import { evaluateGoldenJourneyGate, writeGoldenJourneyEvidence } from './golden-journey-gate.js';

const reference = { runId: 'run-1' };

function gates(overrides: Partial<Record<string, Partial<ValidationEvidenceGate>>> = {}) {
  return VALIDATION_EVIDENCE_GATE_IDS.map((id) => ({
    id,
    status: 'passed' as const,
    references: [reference],
    ...overrides[id],
  }));
}

function bundle(overrides: Partial<ValidationEvidenceBundle> = {}): ValidationEvidenceBundle {
  return {
    schemaVersion: '1',
    campaignId: 'real-todo-v1',
    sourceRevision: 'a'.repeat(40),
    projectId: 'project-1',
    runId: 'run-1',
    environmentReadiness: {
      status: 'passed',
      environmentId: 'environment-1',
      checks: [{ boundary: 'docker', status: 'passed', durationMs: 1 }],
    },
    gates: gates(),
    attempts: [
      {
        reference,
        provider: 'claude',
        selectedModel: 'haiku',
        executedModel: 'claude-haiku-4-5',
        status: 'succeeded',
        durationMs: 1_000,
        outputArtifacts: [],
      },
      {
        reference,
        provider: 'codex',
        selectedModel: 'gpt-5.6-luna',
        status: 'succeeded',
        outputArtifacts: [],
      },
    ],
    usage: {
      attemptsByStep: { 'step-1': 2 },
      subscriptionQuotaUnits: 42,
      subscriptionQuotaUnitsByProvider: { claude: 42 },
    },
    checkpoints: [],
    deterministicResults: [],
    browserEvidence: [],
    databaseEvidence: [],
    terminalState: {
      status: 'completed',
      startedAt: '2026-08-16T00:00:00.000Z',
      completedAt: '2026-08-16T00:10:00.000Z',
    },
    skippedGates: [],
    outcome: 'accepted',
    publishedAt: '2026-08-16T00:10:01.000Z',
    ...overrides,
  };
}

function evaluate(evidence: ValidationEvidenceBundle | null, runStatus = 'completed') {
  return evaluateGoldenJourneyGate({
    scenarioId: 'toy',
    projectId: 'project-1',
    runId: 'run-1',
    runStatus,
    evidence: evidence === null ? null : { bundle: evidence, artifact: artifact() },
  });
}

function artifact(): StoredArtifact {
  return {
    metadata: {
      projectId: 'project-1',
      name: 'validation-evidence',
      revision: 1,
      contentType: 'application/json',
      createdAt: '2026-08-16T00:10:01.000Z',
      createdBy: 'system',
      sha256: 'b'.repeat(64),
    },
    content: {},
  };
}

describe('evaluateGoldenJourneyGate', () => {
  it('keeps the base fixture parseable by the published contract', () => {
    expect(() => ValidationEvidenceBundleSchema.parse(bundle())).not.toThrow();
  });

  it('passes when the run completed, the outcome was accepted and every gate passed', () => {
    const verdict = evaluate(bundle());
    expect(verdict.status).toBe('passed');
    expect(verdict.reasons).toEqual([]);
    expect(verdict.failedGates).toEqual([]);
    expect(verdict.outcome).toBe('accepted');
    expect(verdict.sourceRevision).toBe('a'.repeat(40));
    expect(verdict.executedModels).toEqual(['claude-haiku-4-5', 'gpt-5.6-luna']);
    expect(verdict.attempts).toBe(2);
    expect(verdict.quotaUnits).toBe(42);
    expect(verdict.durationMs).toBe(600_000);
  });

  // `classifyOutcome` currently refuses `accepted` to any bundle with a gate
  // outside `passed`, so this pairing cannot be published today. Asserted anyway:
  // the gate reads the gates, not one classifier's summary of them, and this is
  // what pins that if the classifier ever stops agreeing.
  it('fails a bundle claiming accepted while its database-match gate was skipped', () => {
    const verdict = evaluate(
      bundle({
        gates: gates({
          'database-match': { status: 'skipped', failureClass: 'environment' },
        }),
        skippedGates: ['database-match'],
      }),
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.failedGates).toEqual([
      {
        id: 'database-match',
        status: 'skipped',
        failureClass: 'environment',
        references: [reference],
      },
    ]);
    expect(verdict.reasons).toEqual(['gate database-match is skipped']);
  });

  it('names every unmet condition when the run failed outright', () => {
    const verdict = evaluate(
      bundle({
        terminalState: { status: 'failed' },
        outcome: 'product-failed',
        gates: gates({
          'browser-acceptance': {
            status: 'failed',
            failureClass: 'product',
            summary: 'Todo never appeared',
          },
        }),
      }),
      'failed',
    );
    expect(verdict.status).toBe('failed');
    expect(verdict.runStatus).toBe('failed');
    expect(verdict.reasons).toEqual([
      'terminal state is failed, expected completed',
      'outcome is product-failed, expected accepted',
      'gate browser-acceptance is failed',
    ]);
    expect(verdict.durationMs).toBeUndefined();
  });

  it('reports a budget-exhausted run as exhausted rather than failed', () => {
    const verdict = evaluate(
      bundle({
        terminalState: {
          status: 'failed',
          error: {
            name: 'ExecutionError',
            message: 'Validation campaign active time exhausted',
            code: 'VALIDATION_CAMPAIGN_LIMIT',
          },
        },
        outcome: 'product-failed',
        gates: gates({
          'terminal-run': { status: 'failed', failureClass: 'environment' },
        }),
      }),
      'failed',
    );
    expect(verdict.status).toBe('exhausted');
    // An exhausted run still has to show how far it got.
    expect(verdict.failedGates.map((gate) => gate.id)).toEqual(['terminal-run']);
  });

  it('reports an environment-blocked outcome as environment-blocked', () => {
    const verdict = evaluate(
      bundle({
        terminalState: { status: 'failed' },
        outcome: 'environment-blocked',
        gates: gates({
          'preview-healthy': { status: 'unavailable', failureClass: 'environment' },
        }),
      }),
      'failed',
    );
    expect(verdict.status).toBe('environment-blocked');
    expect(verdict.failedGates.map((gate) => gate.id)).toEqual(['preview-healthy']);
  });

  it('reports a missing bundle as no-evidence', () => {
    const verdict = evaluate(null, 'completed');
    expect(verdict.status).toBe('no-evidence');
    expect(verdict.outcome).toBeUndefined();
    expect(verdict.sourceRevision).toBeUndefined();
    expect(verdict.attempts).toBe(0);
    expect(verdict.quotaUnits).toBe(0);
    expect(verdict.failedGates).toEqual([]);
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/validation-evidence bundle/i);
    expect(verdict.reasons[0]).toMatch(/mock mode/i);
  });

  // #578: a run cut short before it terminated has no bundle for a reason that
  // has nothing to do with mock mode, and blaming mock mode hid the real
  // defect (the driver returning while the run was still `queued`).
  it('blames the unfinished run, not mock mode, when a non-terminal run has no bundle', () => {
    const verdict = evaluate(null, 'queued');
    expect(verdict.status).toBe('no-evidence');
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toContain('queued');
    expect(verdict.reasons[0]).not.toMatch(/mock mode/i);
  });
});

describe('writeGoldenJourneyEvidence', () => {
  it('writes each bundle verbatim and one README summarising every scenario', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-foundry-golden-journey-'));
    try {
      const passing = bundle();
      const failing = bundle({
        projectId: 'project-2',
        runId: 'run-2',
        terminalState: { status: 'failed' },
        outcome: 'product-failed',
        gates: gates({
          'browser-acceptance': {
            status: 'failed',
            failureClass: 'product',
            summary: 'Todo never appeared',
          },
        }),
      });
      const verdicts = [
        evaluate(passing),
        evaluateGoldenJourneyGate({
          scenarioId: 'crud-heavy',
          projectId: 'project-2',
          runId: 'run-2',
          runStatus: 'failed',
          evidence: { bundle: failing, artifact: artifact() },
        }),
        evaluateGoldenJourneyGate({
          scenarioId: 'auth-heavy',
          projectId: 'project-3',
          runId: 'run-3',
          runStatus: 'completed',
          evidence: null,
        }),
      ];

      await writeGoldenJourneyEvidence(join(dir, 'evidence'), [
        { verdict: verdicts[0]!, bundle: passing },
        { verdict: verdicts[1]!, bundle: failing },
        { verdict: verdicts[2]!, bundle: null },
      ]);

      const written = JSON.parse(
        await readFile(join(dir, 'evidence', 'toy', 'bundle.json'), 'utf8'),
      );
      expect(written).toEqual(passing);

      await expect(
        readFile(join(dir, 'evidence', 'auth-heavy', 'bundle.json'), 'utf8'),
      ).rejects.toThrow();

      const readme = await readFile(join(dir, 'evidence', 'README.md'), 'utf8');
      expect(readme).toContain('| toy |');
      expect(readme).toContain('a'.repeat(40));
      expect(readme).toContain('claude-haiku-4-5');
      expect(readme).toContain('project-2');
      expect(readme).toContain('run-3');
      expect(readme).toContain('browser-acceptance');
      // The passing scenario needs no detail section; the other two do.
      expect(readme).toContain('### crud-heavy');
      expect(readme).toContain('### auth-heavy');
      expect(readme).not.toContain('### toy');
      expect(readme.endsWith('\n')).toBe(true);
      expect(readme.endsWith('\n\n')).toBe(false);
      expect(readme.split('\n').some((line) => /\s$/.test(line))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
