import { describe, expect, it } from 'vitest';
import {
  DecisionExportRowSchema,
  ExperimentRecordSchema,
  RegressionGateResultSchema,
  RouterDecisionLogEntrySchema,
} from './experiment.js';

const decision = {
  schemaVersion: '1' as const,
  id: '01J000000000000000000000',
  routeId: '01J000000000000000000001',
  createdAt: '2026-07-24T00:00:00.000Z',
  projectId: 'project-1',
  runId: 'run-1',
  nodeId: 'implement',
  workflowId: 'golden-flow-e2e-v1',
  harnessVersion: 'v3',
  taskKind: 'implementation' as const,
  category: 'implementation/frontend' as const,
  role: 'developer' as const,
  provider: 'claude' as const,
  modelId: 'claude-opus',
  model: 'claude-opus-4-8',
  approved: true,
  firstPass: true,
  repairs: 0,
  durationMs: 12_000,
  confidence: 0.82,
  sampleSize: 9,
};

describe('RouterDecisionLogEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    expect(RouterDecisionLogEntrySchema.parse(decision)).toMatchObject(decision);
  });

  it('rejects an unknown field (strict)', () => {
    expect(() => RouterDecisionLogEntrySchema.parse({ ...decision, extra: 'nope' })).toThrow();
  });

  it('accepts an empty model string, matching ModelDefinitionSchema.model (no min length)', () => {
    // Catalog entries interpolate `${ENV_VAR:-}` to '' when the env var is
    // unset (see models/catalog.yaml's codex/agy fast/default variants) —
    // exactly what mock-executor-mode runs select. ModelDefinitionSchema.model
    // has no min-length constraint for this reason; this schema must not add one.
    expect(() => RouterDecisionLogEntrySchema.parse({ ...decision, model: '' })).not.toThrow();
  });
});

describe('DecisionExportRowSchema', () => {
  it('strips projectId/runId/nodeId/id/routeId from an entry', () => {
    const row = DecisionExportRowSchema.parse(decision);
    expect(row).not.toHaveProperty('projectId');
    expect(row).not.toHaveProperty('runId');
    expect(row).not.toHaveProperty('nodeId');
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('routeId');
    expect(row.modelId).toBe('claude-opus');
  });
});

describe('ExperimentRecordSchema', () => {
  it('accepts a two-variant experiment with a stop rule', () => {
    const record = ExperimentRecordSchema.parse({
      schemaVersion: '1',
      id: 'exp-1',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      hypothesis: 'Opus first-pass rate beats Sonnet on frontend implementation tasks.',
      variants: [
        { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
        { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
      ],
      population: { taskKinds: ['implementation'], targetSampleSize: 30 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
      status: 'draft',
    });
    expect(record.variants).toHaveLength(2);
  });

  it('rejects a single-variant experiment', () => {
    expect(() =>
      ExperimentRecordSchema.parse({
        schemaVersion: '1',
        id: 'exp-1',
        createdAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
        hypothesis: 'x'.repeat(10),
        variants: [
          { key: 'control', description: 'only one', target: { kind: 'model', modelId: 'a' } },
        ],
        population: { taskKinds: ['implementation'], targetSampleSize: 30 },
        stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
        status: 'draft',
      }),
    ).toThrow();
  });
});

describe('RegressionGateResultSchema', () => {
  it('accepts a pass verdict with deltas', () => {
    const result = RegressionGateResultSchema.parse({
      schemaVersion: '1',
      createdAt: '2026-07-24T00:00:00.000Z',
      baselineRef: 'abc1234',
      freshCreatedAt: '2026-07-24T00:00:00.000Z',
      verdict: 'pass',
      reasons: [],
      deltas: [
        {
          caseId: 'greenfield-clamp-util',
          modelId: 'opus',
          baselineStatus: 'passed',
          freshStatus: 'passed',
          statusRegressed: false,
          durationDeltaMs: 500,
          repairsDelta: 0,
        },
      ],
    });
    expect(result.verdict).toBe('pass');
  });
});
