import {
  StepAttemptSchema,
  StepRunSchema,
  WorkflowRunSchema,
  type RunError,
  type StepAttempt,
  type StepAttemptStatus,
  type StepRun,
  type StepRunStatus,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@agent-foundry/contracts';
import { InvalidStateTransitionError } from './errors.js';

const workflowRunTransitions: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  queued: ['running', 'cancel_requested', 'cancelled', 'failed'],
  running: ['pause_requested', 'cancel_requested', 'completed', 'failed'],
  pause_requested: ['paused', 'cancel_requested', 'failed'],
  paused: ['running', 'cancel_requested', 'cancelled', 'failed'],
  cancel_requested: ['cancelled', 'failed'],
  cancelled: [],
  completed: [],
  failed: [],
};

const stepRunTransitions: Record<StepRunStatus, readonly StepRunStatus[]> = {
  pending: ['running', 'skipped', 'cancelled'],
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

const stepAttemptTransitions: Record<StepAttemptStatus, readonly StepAttemptStatus[]> = {
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function transitionWorkflowRun(
  run: WorkflowRun,
  status: WorkflowRunStatus,
  now: Date,
  patch: { currentStepRunId?: string; error?: RunError } = {},
): WorkflowRun {
  assertTransition('workflow-run', run.status, status, workflowRunTransitions);
  const timestamp = now.toISOString();
  const updated: Record<string, unknown> = { ...run, ...patch, status, updatedAt: timestamp };
  if (!run.startedAt && status !== 'queued') updated.startedAt = timestamp;
  if (isWorkflowRunTerminal(status)) updated.completedAt = timestamp;
  if (status !== 'failed') delete updated.error;
  return WorkflowRunSchema.parse(updated);
}

export function transitionStepRun(
  step: StepRun,
  status: StepRunStatus,
  now: Date,
  patch: { error?: RunError } = {},
): StepRun {
  assertTransition('step-run', step.status, status, stepRunTransitions);
  const timestamp = now.toISOString();
  const updated: Record<string, unknown> = { ...step, ...patch, status, updatedAt: timestamp };
  if (!step.startedAt && status === 'running') updated.startedAt = timestamp;
  if (isStepRunTerminal(status)) updated.completedAt = timestamp;
  if (status !== 'failed') delete updated.error;
  return StepRunSchema.parse(updated);
}

export function transitionStepAttempt(
  attempt: StepAttempt,
  status: StepAttemptStatus,
  now: Date,
  patch: Partial<
    Pick<
      StepAttempt,
      'durationMs' | 'usage' | 'error' | 'executedModel' | 'outputArtifacts' | 'routeDecision'
    >
  > = {},
): StepAttempt {
  assertTransition('step-attempt', attempt.status, status, stepAttemptTransitions);
  const timestamp = now.toISOString();
  const updated: Record<string, unknown> = {
    ...attempt,
    ...patch,
    status,
    updatedAt: timestamp,
    completedAt: timestamp,
  };
  if (status !== 'failed') delete updated.error;
  return StepAttemptSchema.parse(updated);
}

function assertTransition<TStatus extends string>(
  entity: 'workflow-run' | 'step-run' | 'step-attempt',
  from: TStatus,
  to: TStatus,
  transitions: Record<TStatus, readonly TStatus[]>,
): void {
  if (!transitions[from].includes(to)) {
    throw new InvalidStateTransitionError(entity, from, to);
  }
}

function isWorkflowRunTerminal(status: WorkflowRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isStepRunTerminal(status: StepRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped'
  );
}
