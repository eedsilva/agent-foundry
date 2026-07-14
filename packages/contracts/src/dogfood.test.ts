import { describe, expect, it } from 'vitest';
import { DogfoodReportSchema, DogfoodRunRecordSchema, DogfoodTaskSchema } from './index.js';

const task = {
  id: 'domain-redaction',
  title: 'Redact domain values from logs',
  issueRef: 'eedsilva/agent-foundry#10',
  workflowId: 'dogfood-task-v1',
  prompt:
    'Implement a redaction utility that strips domain-specific values from structured log output before it is persisted.',
  baselineRef: 'a1b2c3d',
  allowedFiles: ['packages/domain/src/redact.ts'],
};

const runRecord = {
  schemaVersion: '1',
  taskId: 'domain-redaction',
  attempt: 1,
  issueRef: 'eedsilva/agent-foundry#10',
  baselineRef: 'a1b2c3d',
  projectId: 'project-1',
  runId: 'run-1',
  startedAt: '2026-07-14T00:00:00.000Z',
  status: 'passed',
  durationMs: 1_200,
  repairs: { iterations: 0, repairEvents: 0 },
  humanEdit: { status: 'pending' },
};

describe('dogfood contracts', () => {
  it('parses a valid dogfood task', () => {
    expect(DogfoodTaskSchema.safeParse(task).success).toBe(true);
  });

  it('parses a valid dogfood run record', () => {
    expect(DogfoodRunRecordSchema.safeParse(runRecord).success).toBe(true);
  });

  it('rejects a run record missing humanEdit', () => {
    const { humanEdit: _humanEdit, ...withoutHumanEdit } = runRecord;
    expect(DogfoodRunRecordSchema.safeParse(withoutHumanEdit).success).toBe(false);
  });

  it('rejects a report with no runs', () => {
    const report = {
      schemaVersion: '1',
      createdAt: '2026-07-14T00:00:00.000Z',
      baselineRef: 'a1b2c3d',
      runs: [],
      limitations: [],
    };
    expect(DogfoodReportSchema.safeParse(report).success).toBe(false);
  });
});
