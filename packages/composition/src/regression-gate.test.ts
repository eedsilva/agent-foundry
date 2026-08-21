import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '@agent-foundry/contracts';
import { compareBenchmarkReports, shouldRunRegressionGate } from './regression-gate.js';

function report(overrides: Partial<BenchmarkReport> = {}): BenchmarkReport {
  return {
    schemaVersion: '1',
    createdAt: '2026-07-24T00:00:00.000Z',
    baselineRef: 'abc1234',
    runs: [],
    limitations: [],
    ...overrides,
  } as BenchmarkReport;
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1' as const,
    attempt: 1,
    baselineRef: 'abc1234',
    projectId: 'project-1',
    runId: 'run-1',
    startedAt: '2026-07-24T00:00:00.000Z',
    status: 'passed' as const,
    durationMs: 10_000,
    checks: [],
    repairs: { iterations: 1, repairEvents: 0 },
    humanEdit: { status: 'pending', files: [] },
    caseId: 'greenfield-clamp-util',
    caseKind: 'greenfield' as const,
    modelId: 'opus',
    ...overrides,
  };
}

describe('compareBenchmarkReports', () => {
  const enabledModelIds = new Set(['opus']);

  it('passes when every case keeps or improves status', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'passed', durationMs: 9_000 })] });

    const result = compareBenchmarkReports(fresh, baseline, enabledModelIds);
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
    expect(result.deltas[0]?.durationDeltaMs).toBe(-1_000);
  });

  it('fails when a case regresses from passed to failed', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'failed' })] });

    const result = compareBenchmarkReports(fresh, baseline, enabledModelIds);
    expect(result.verdict).toBe('fail');
    expect(result.reasons[0]).toContain('regressed');
    expect(result.deltas[0]?.statusRegressed).toBe(true);
  });

  it('fails when a baseline case is missing from the fresh report', () => {
    const baseline = report({ runs: [run({ caseId: 'a' }), run({ caseId: 'b' })] });
    const fresh = report({ runs: [run({ caseId: 'a' })] });

    const result = compareBenchmarkReports(fresh, baseline, enabledModelIds);
    expect(result.verdict).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('missing'))).toBe(true);
  });

  it('skips a missing baseline run when its model is disabled by policy', () => {
    const baseline = report({ runs: [run({ modelId: 'claude-opus' })] });

    const result = compareBenchmarkReports(report(), baseline, new Set());

    expect(result.verdict).toBe('pass');
    expect(result.reasons).toEqual([]);
    expect(result.skipped).toEqual([
      {
        caseId: 'greenfield-clamp-util',
        modelId: 'claude-opus',
        reason: 'model disabled by policy',
      },
    ]);
  });

  it('does not fail on a duration or repairs regression alone', () => {
    const baseline = report({
      runs: [
        run({
          status: 'passed',
          durationMs: 5_000,
          repairs: { iterations: 1, repairEvents: 0 },
        }),
      ],
    });
    const fresh = report({
      runs: [
        run({
          status: 'passed',
          durationMs: 20_000,
          repairs: { iterations: 3, repairEvents: 2 },
        }),
      ],
    });

    const result = compareBenchmarkReports(fresh, baseline, enabledModelIds);
    expect(result.verdict).toBe('pass');
    expect(result.deltas[0]?.durationDeltaMs).toBe(15_000);
    expect(result.deltas[0]?.repairsDelta).toBe(2);
  });
});

describe('shouldRunRegressionGate', () => {
  it('returns true when the catalog file changed', () => {
    expect(shouldRunRegressionGate(['README.md', 'models/catalog.yaml'])).toBe(true);
  });

  it('returns true when the harness manifest changed', () => {
    expect(shouldRunRegressionGate(['harness/manifest.json'])).toBe(true);
  });

  it('returns false when no promotion-sensitive path changed', () => {
    expect(
      shouldRunRegressionGate(['README.md', 'packages/composition/src/regression-gate.ts']),
    ).toBe(false);
  });

  it('returns false for an empty change set', () => {
    expect(shouldRunRegressionGate([])).toBe(false);
  });
});
