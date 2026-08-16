import { describe, expect, it } from 'vitest';
import type { RunDetailResponse, StepRun, WorkflowDefinition } from '@agent-foundry/contracts';
import { formatElapsed, runProgress } from './run-progress';

describe('formatElapsed', () => {
  it('formats 0ms as 0s', () => {
    expect(formatElapsed(0)).toBe('0s');
  });

  it('formats 59s as 59s', () => {
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('formats 60s as 1m 00s', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
  });

  it('formats 61s as 1m 01s', () => {
    expect(formatElapsed(61_000)).toBe('1m 01s');
  });

  it('formats 2m 14s', () => {
    expect(formatElapsed(134_000)).toBe('2m 14s');
  });

  it('formats 3599s as 59m 59s', () => {
    expect(formatElapsed(3_599_000)).toBe('59m 59s');
  });

  it('formats 3600s as 1h 00m', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
  });

  it('formats 3661s as 1h 01m', () => {
    expect(formatElapsed(3_661_000)).toBe('1h 01m');
  });
});

function makeStep(overrides: Partial<StepRun> = {}): StepRun {
  return {
    id: 'step-1',
    runId: 'run-1',
    nodeId: 'plan',
    stepId: 'plan',
    stepType: 'agent',
    status: 'completed',
    version: 1,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  } as StepRun;
}

function makeRunDetail(steps: StepRun[]): RunDetailResponse {
  return {
    run: {
      id: 'run-1',
      projectId: 'p1',
      workflowId: 'wf-1',
      status: 'running',
      version: 1,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    } as RunDetailResponse['run'],
    steps: steps.map((step) => ({ step, attempts: [] })),
  };
}

function makeWorkflowDef(nodeIds: string[]): WorkflowDefinition {
  return {
    schemaVersion: '1',
    id: 'wf-1',
    name: 'Workflow',
    description: 'desc',
    stack: 'stack',
    nodes: nodeIds.map((id) => ({
      id,
      type: 'agent',
      role: 'builder',
      taskKind: 'implementation',
      title: `Título ${id}`,
      instructions: 'faça isso',
      inputArtifacts: [],
      outputArtifact: `${id}.out`,
      secretRefs: [],
      mutatesWorkspace: false,
      harnessTags: [],
      profile: {},
      maxAttempts: 2,
    })),
  } as unknown as WorkflowDefinition;
}

describe('runProgress', () => {
  it('returns zero progress and no title when there is no runDetail', () => {
    expect(runProgress(null, null)).toEqual({ done: 0, total: null, currentStepTitle: null });
  });

  it('still reports a total from workflowDef even without a runDetail yet', () => {
    expect(runProgress(null, makeWorkflowDef(['plan', 'implement', 'verify']))).toEqual({
      done: 0,
      total: 3,
      currentStepTitle: null,
    });
  });

  it('reports total as null when workflowDef is unavailable', () => {
    const detail = makeRunDetail([
      makeStep({ id: 's1', nodeId: 'plan', status: 'completed' }),
      makeStep({ id: 's2', nodeId: 'implement', status: 'running' }),
    ]);
    expect(runProgress(detail, null)).toEqual({ done: 1, total: null, currentStepTitle: null });
  });

  it('counts every terminal step as done when all steps are terminal', () => {
    const detail = makeRunDetail([
      makeStep({ id: 's1', nodeId: 'plan', status: 'completed' }),
      makeStep({ id: 's2', nodeId: 'implement', status: 'failed' }),
      makeStep({ id: 's3', nodeId: 'verify', status: 'skipped' }),
    ]);
    const workflowDef = makeWorkflowDef(['plan', 'implement', 'verify']);
    expect(runProgress(detail, workflowDef)).toEqual({
      done: 3,
      total: 3,
      currentStepTitle: null,
    });
  });

  it('names the current step when exactly one is in flight', () => {
    const detail = makeRunDetail([
      makeStep({ id: 's1', nodeId: 'plan', status: 'completed' }),
      makeStep({ id: 's2', nodeId: 'implement', status: 'running' }),
    ]);
    const workflowDef = makeWorkflowDef(['plan', 'implement', 'verify']);
    expect(runProgress(detail, workflowDef)).toEqual({
      done: 1,
      total: 3,
      currentStepTitle: 'Título implement',
    });
  });

  it('leaves currentStepTitle null when more than one step is in flight', () => {
    const detail = makeRunDetail([
      makeStep({ id: 's1', nodeId: 'plan', status: 'running' }),
      makeStep({ id: 's2', nodeId: 'implement', status: 'pending' }),
    ]);
    const workflowDef = makeWorkflowDef(['plan', 'implement', 'verify']);
    expect(runProgress(detail, workflowDef)).toEqual({
      done: 0,
      total: 3,
      currentStepTitle: null,
    });
  });

  it('ignores invalidated steps left behind by a retry', () => {
    const detail = makeRunDetail([
      makeStep({
        id: 'old-implement',
        nodeId: 'implement',
        status: 'completed',
        invalidatedAt: '2026-08-10T00:01:00.000Z',
      }),
      makeStep({ id: 'plan', nodeId: 'plan', status: 'completed' }),
      makeStep({ id: 'new-implement', nodeId: 'implement', status: 'running' }),
    ]);
    const workflowDef = makeWorkflowDef(['plan', 'implement']);

    expect(runProgress(detail, workflowDef)).toEqual({
      done: 1,
      total: 2,
      currentStepTitle: 'Título implement',
    });
  });
});
