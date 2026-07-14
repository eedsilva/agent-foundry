import { describe, expect, it } from 'vitest';
import type {
  StepAttempt,
  StepAttemptStatus,
  StepRun,
  StepRunStatus,
  WorkflowRun,
  WorkflowRunStatus,
} from '@agent-foundry/contracts';
import * as domain from './index.js';

const now = new Date('2026-07-14T12:00:00.000Z');
const exported = domain as Record<string, unknown>;

describe('run state transitions', () => {
  it('exports transition helpers', () => {
    expect(exported.transitionWorkflowRun).toBeDefined();
    expect(exported.transitionStepRun).toBeDefined();
    expect(exported.transitionStepAttempt).toBeDefined();
  });

  it('starts and completes a workflow run with lifecycle timestamps', () => {
    const queued: WorkflowRun = {
      id: 'run-1',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      status: 'queued',
      version: 1,
      createdAt: '2026-07-14T11:00:00.000Z',
      updatedAt: '2026-07-14T11:00:00.000Z',
    };

    const running = domain.transitionWorkflowRun(queued, 'running', now);
    const completed = domain.transitionWorkflowRun(
      running,
      'completed',
      new Date('2026-07-14T13:00:00.000Z'),
    );

    expect(running).toMatchObject({
      status: 'running',
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(completed).toMatchObject({
      status: 'completed',
      completedAt: '2026-07-14T13:00:00.000Z',
    });
  });

  it('rejects transitions from terminal states', () => {
    const completed: WorkflowRun = {
      id: 'run-1',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      status: 'completed',
      version: 3,
      createdAt: '2026-07-14T11:00:00.000Z',
      updatedAt: '2026-07-14T13:00:00.000Z',
      startedAt: '2026-07-14T12:00:00.000Z',
      completedAt: '2026-07-14T13:00:00.000Z',
    };

    expect(() => domain.transitionWorkflowRun(completed, 'running', now)).toThrow(
      domain.InvalidStateTransitionError,
    );
  });

  it('transitions step and attempt failures with sanitized errors', () => {
    const step: StepRun = {
      id: 'step-run-1',
      runId: 'run-1',
      nodeId: 'node-1',
      stepId: 'step-1',
      stepType: 'agent',
      status: 'running',
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
    };
    const attempt: StepAttempt = {
      id: 'attempt-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      sequence: 1,
      executorKind: 'agent',
      provider: 'mock',
      model: 'mock/default',
      context: {
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        nodeId: 'node-1',
        stepId: 'step-1',
      },
      status: 'running',
      version: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      inputArtifacts: [],
      outputArtifacts: [],
    };
    const error = { name: 'ExecutionError', message: 'provider failed', exitCode: 1 };

    expect(domain.transitionStepRun(step, 'failed', now, { error })).toMatchObject({
      status: 'failed',
      error,
      completedAt: now.toISOString(),
    });
    expect(domain.transitionStepAttempt(attempt, 'failed', now, { error })).toMatchObject({
      status: 'failed',
      error,
      completedAt: now.toISOString(),
    });
  });

  it('allows a pending step to be skipped without pretending it started', () => {
    const skipped = domain.transitionStepRun(stepRunAt('pending'), 'skipped', now);

    expect(skipped).toMatchObject({ status: 'skipped', completedAt: now.toISOString() });
    expect(skipped.startedAt).toBeUndefined();
  });

  it('rejects every workflow transition outside the declared graph', () => {
    const statuses: WorkflowRunStatus[] = [
      'queued',
      'running',
      'pause_requested',
      'paused',
      'cancel_requested',
      'cancelled',
      'completed',
      'failed',
    ];
    const allowed: Record<WorkflowRunStatus, WorkflowRunStatus[]> = {
      queued: ['running', 'cancel_requested', 'cancelled', 'failed'],
      running: ['pause_requested', 'cancel_requested', 'completed', 'failed'],
      pause_requested: ['paused', 'cancel_requested', 'failed'],
      paused: ['running', 'cancel_requested', 'cancelled', 'failed'],
      cancel_requested: ['cancelled', 'failed'],
      cancelled: [],
      completed: [],
      failed: [],
    };

    for (const from of statuses) {
      for (const to of statuses.filter((candidate) => !allowed[from].includes(candidate))) {
        expect(() =>
          domain.transitionWorkflowRun(workflowRunAt(from), to, now, {
            ...(to === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
          }),
        ).toThrow(domain.InvalidStateTransitionError);
      }
    }
  });

  it('rejects every step and attempt transition outside their declared graphs', () => {
    const stepStatuses: StepRunStatus[] = [
      'pending',
      'running',
      'completed',
      'failed',
      'cancelled',
      'skipped',
    ];
    const stepAllowed: Record<StepRunStatus, StepRunStatus[]> = {
      pending: ['running', 'skipped', 'cancelled'],
      running: ['completed', 'failed', 'cancelled'],
      completed: [],
      failed: [],
      cancelled: [],
      skipped: [],
    };
    for (const from of stepStatuses) {
      for (const to of stepStatuses.filter((candidate) => !stepAllowed[from].includes(candidate))) {
        expect(() =>
          domain.transitionStepRun(stepRunAt(from), to, now, {
            ...(to === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
          }),
        ).toThrow(domain.InvalidStateTransitionError);
      }
    }

    const attemptStatuses: StepAttemptStatus[] = ['running', 'succeeded', 'failed', 'cancelled'];
    const attemptAllowed: Record<StepAttemptStatus, StepAttemptStatus[]> = {
      running: ['succeeded', 'failed', 'cancelled'],
      succeeded: [],
      failed: [],
      cancelled: [],
    };
    for (const from of attemptStatuses) {
      for (const to of attemptStatuses.filter(
        (candidate) => !attemptAllowed[from].includes(candidate),
      )) {
        expect(() =>
          domain.transitionStepAttempt(attemptAt(from), to, now, {
            ...(to === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
          }),
        ).toThrow(domain.InvalidStateTransitionError);
      }
    }
  });
});

function workflowRunAt(status: WorkflowRunStatus): WorkflowRun {
  const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
  return {
    id: 'run-graph',
    projectId: 'project-1',
    workflowId: 'workflow-1',
    status,
    version: 1,
    createdAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T11:30:00.000Z',
    ...(status !== 'queued' ? { startedAt: '2026-07-14T11:10:00.000Z' } : {}),
    ...(terminal ? { completedAt: '2026-07-14T11:30:00.000Z' } : {}),
    ...(status === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
  };
}

function stepRunAt(status: StepRunStatus): StepRun {
  const terminal = status !== 'pending' && status !== 'running';
  return {
    id: 'step-graph',
    runId: 'run-graph',
    nodeId: 'node',
    stepId: 'step',
    stepType: 'agent',
    status,
    version: 1,
    createdAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T11:30:00.000Z',
    ...(status !== 'pending' ? { startedAt: '2026-07-14T11:10:00.000Z' } : {}),
    ...(terminal ? { completedAt: '2026-07-14T11:30:00.000Z' } : {}),
    ...(status === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
  };
}

function attemptAt(status: StepAttemptStatus): StepAttempt {
  return {
    id: 'attempt-graph',
    runId: 'run-graph',
    stepRunId: 'step-graph',
    sequence: 1,
    executorKind: 'agent',
    provider: 'mock',
    model: 'mock/default',
    context: {
      projectId: 'project-graph',
      workflowId: 'web-app-v1',
      nodeId: 'node',
      stepId: 'step',
    },
    status,
    version: 1,
    createdAt: '2026-07-14T11:00:00.000Z',
    updatedAt: '2026-07-14T11:30:00.000Z',
    startedAt: '2026-07-14T11:00:00.000Z',
    ...(status !== 'running' ? { completedAt: '2026-07-14T11:30:00.000Z' } : {}),
    ...(status === 'failed' ? { error: { name: 'ExecutionError', message: 'failed' } } : {}),
    inputArtifacts: [],
    outputArtifacts: [],
  };
}
