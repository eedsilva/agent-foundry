import { describe, expect, it } from 'vitest';
import type { BenchmarkReport } from '@agent-foundry/contracts';
import { compareBenchmarkReports } from './regression-gate.js';

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
  it('passes when every case keeps or improves status', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'passed', durationMs: 9_000 })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
    expect(result.deltas[0]?.durationDeltaMs).toBe(-1_000);
  });

  it('fails when a case regresses from passed to failed', () => {
    const baseline = report({ runs: [run({ status: 'passed' })] });
    const fresh = report({ runs: [run({ status: 'failed' })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('fail');
    expect(result.reasons[0]).toContain('regressed');
    expect(result.deltas[0]?.statusRegressed).toBe(true);
  });

  it('fails when a baseline case is missing from the fresh report', () => {
    const baseline = report({ runs: [run({ caseId: 'a' }), run({ caseId: 'b' })] });
    const fresh = report({ runs: [run({ caseId: 'a' })] });

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('fail');
    expect(result.reasons.some((reason) => reason.includes('missing'))).toBe(true);
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

    const result = compareBenchmarkReports(fresh, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.deltas[0]?.durationDeltaMs).toBe(15_000);
    expect(result.deltas[0]?.repairsDelta).toBe(2);
  });
});
