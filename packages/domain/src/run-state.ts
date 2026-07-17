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
  running: [
    'pause_requested',
    'awaiting_approval',
    'cancel_requested',
    'completed',
    'failed',
    'rejected',
  ],
  // 'completed' covers a pause requested after the final step already started.
  pause_requested: ['paused', 'cancel_requested', 'completed', 'failed'],
  // 'queued' is the resume path: the run goes back through the queue so a
  // worker picks it up with a fresh lease.
  paused: ['queued', 'running', 'cancel_requested', 'cancelled', 'failed'],
  // 'queued' is how a decision continues the run; the orchestrator's replay
  // decides whether that means completing, resuming, or terminal rejection.
  // 'running' tolerates a stray redelivery while parked, same as 'paused':
  // the gate just re-halts idempotently instead of crashing the run.
  awaiting_approval: ['queued', 'running', 'cancel_requested', 'cancelled', 'rejected'],
  cancel_requested: ['cancelled', 'failed'],
  cancelled: [],
  // Step retry re-opens a finished run; completed steps are reused by
  // idempotency key, so re-queueing never repeats approved work.
  completed: ['queued'],
  failed: ['queued'],
  rejected: [],
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
  patch: {
    currentStepRunId?: string;
    error?: RunError;
    pause?: WorkflowRun['pause'];
    retry?: WorkflowRun['retry'];
  } = {},
): WorkflowRun {
  assertTransition('workflow-run', run.status, status, workflowRunTransitions);
  const timestamp = now.toISOString();
  const updated: Record<string, unknown> = { ...run, ...patch, status, updatedAt: timestamp };
  if (!run.startedAt && status !== 'queued') updated.startedAt = timestamp;
  if (isWorkflowRunTerminal(status)) {
    updated.completedAt = timestamp;
    delete updated.retry;
  } else {
    delete updated.completedAt;
  }
  if (status !== 'failed') delete updated.error;
  if (status !== 'paused') delete updated.pause;
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
      | 'durationMs'
      | 'usage'
      | 'error'
      | 'executedModel'
      | 'outputArtifacts'
      | 'routeDecision'
      | 'commit'
      | 'previewSessionId'
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
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'rejected'
  );
}

function isStepRunTerminal(status: StepRunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'skipped'
  );
}
