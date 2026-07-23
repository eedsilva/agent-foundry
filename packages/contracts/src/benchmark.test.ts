import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_CASE_KINDS,
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
} from './benchmark.js';

function validCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sample-case',
    title: 'Sample case',
    workflowId: 'dogfood-task-v1',
    prompt: 'x'.repeat(60),
    baselineRef: '56568a3',
    allowedFiles: ['packages/domain/src/sample.ts'],
    seedFiles: [],
    kind: 'greenfield',
    expectedSignals: ['creates the file'],
    ...overrides,
  };
}

function validRunRecord(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    caseId: 'sample-case',
    caseKind: 'greenfield',
    modelId: 'codex-default',
    attempt: 1,
    baselineRef: '56568a3',
    projectId: 'project-1',
    runId: 'run-1',
    startedAt: '2026-07-23T00:00:00.000Z',
    status: 'passed',
    durationMs: 100,
    checks: [],
    repairs: { iterations: 1, repairEvents: 0 },
    ...overrides,
  };
}

describe('BENCHMARK_CASE_KINDS', () => {
  it('lists all six required corpus kinds', () => {
    expect(BENCHMARK_CASE_KINDS).toEqual([
      'greenfield',
      'existing-repo',
      'bug',
      'refactor',
      'review',
      'security-sensitive',
    ]);
  });
});

describe('BenchmarkCaseSchema', () => {
  it('parses a valid case', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase())).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase({ kind: 'unknown' }))).toThrow();
  });

  it('rejects a case with no expected signals', () => {
    expect(() => BenchmarkCaseSchema.parse(validCase({ expectedSignals: [] }))).toThrow();
  });

  it('rejects an issueRef field carried over from DogfoodTask', () => {
    expect(() =>
      BenchmarkCaseSchema.parse(validCase({ issueRef: 'eedsilva/agent-foundry#63' })),
    ).toThrow();
  });
});

describe('BenchmarkRunRecordSchema', () => {
  it('parses a valid run record', () => {
    expect(() => BenchmarkRunRecordSchema.parse(validRunRecord())).not.toThrow();
  });

  it('rejects a record missing modelId', () => {
    const { modelId: _modelId, ...withoutModelId } = validRunRecord();
    expect(() => BenchmarkRunRecordSchema.parse(withoutModelId)).toThrow();
  });
});

describe('BenchmarkReportSchema', () => {
  it('parses a report with at least one run', () => {
    const report = {
      schemaVersion: '1',
      createdAt: '2026-07-23T00:00:00.000Z',
      baselineRef: '56568a3',
      runs: [validRunRecord()],
      limitations: ['example limitation'],
    };
    expect(() => BenchmarkReportSchema.parse(report)).not.toThrow();
  });

  it('rejects an empty runs array', () => {
    const report = {
      schemaVersion: '1',
      createdAt: '2026-07-23T00:00:00.000Z',
      baselineRef: '56568a3',
      runs: [],
      limitations: [],
    };
    expect(() => BenchmarkReportSchema.parse(report)).toThrow();
  });
});
