export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

export class QueueError extends Error {
  override readonly name = 'QueueError';
}

export class ExecutionError extends Error {
  override readonly name = 'ExecutionError';

  constructor(
    message: string,
    readonly details: {
      provider?: string;
      model?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
  }
}

export class QualityGateError extends Error {
  override readonly name = 'QualityGateError';

  constructor(
    message: string,
    readonly nodeId: string,
  ) {
    super(message);
  }
}

export class InvalidStateTransitionError extends Error {
  override readonly name = 'InvalidStateTransitionError';

  constructor(
    readonly entity: 'workflow-run' | 'step-run' | 'step-attempt' | 'preview-session',
    readonly from: string,
    readonly to: string,
  ) {
    super(`Invalid ${entity} transition from ${from} to ${to}`);
  }
}

export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';

  constructor(
    readonly jobId: string,
    readonly workerId: string,
  ) {
    super(`Worker ${workerId} no longer holds the lease for job ${jobId}`);
  }
}

export class VersionConflictError extends Error {
  override readonly name = 'VersionConflictError';

  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      `Version conflict for ${entity} ${id}: expected ${expectedVersion}, found ${actualVersion}`,
    );
  }
}

export class RunCancelledError extends Error {
  override readonly name = 'RunCancelledError';

  constructor(readonly runId?: string) {
    super(runId ? `Workflow run ${runId} was cancelled.` : 'Execution was cancelled.');
  }
}

/** Control-flow signal: a pause was requested and the run reached a step boundary. */
export class RunPausedError extends Error {
  override readonly name = 'RunPausedError';

  constructor(
    readonly runId: string,
    readonly nodeId?: string,
  ) {
    super(`Workflow run ${runId} paused before ${nodeId ?? 'the next step'}.`);
  }
}

export interface ResumeDiagnostic {
  field: string;
  expected: string;
  actual: string;
}

/** Control-flow signal: the run reached an approval-gate node with no decision yet. */
export class ApprovalRequiredError extends Error {
  override readonly name = 'ApprovalRequiredError';

  constructor(
    readonly runId: string,
    readonly nodeId: string,
  ) {
    super(`Workflow run ${runId} is awaiting an approval decision at ${nodeId}.`);
  }
}

/** Control-flow signal: an approval-gate decision rejected the run outright. */
export class ApprovalRejectedError extends Error {
  override readonly name = 'ApprovalRejectedError';

  constructor(
    readonly runId: string,
    readonly nodeId: string,
    readonly decidedBy: string,
  ) {
    super(`Workflow run ${runId} was rejected at ${nodeId} by ${decidedBy}.`);
  }
}

export class ResumeBlockedError extends Error {
  override readonly name = 'ResumeBlockedError';

  constructor(
    readonly runId: string,
    readonly diagnostics: ResumeDiagnostic[],
  ) {
    super(
      `Workflow run ${runId} cannot resume: ` +
        diagnostics.map((item) => `${item.field} changed`).join(', ') +
        '. Restart the project to run against the current state.',
    );
  }
}
