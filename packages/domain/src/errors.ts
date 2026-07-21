import type { ApprovalDecision } from '@agent-foundry/contracts';

export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class ValidationError extends Error {
  override readonly name = 'ValidationError';
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with different input`);
  }
}

export class QueueError extends Error {
  override readonly name = 'QueueError';
}

export class ArtifactTooLargeError extends Error {
  override readonly name = 'ArtifactTooLargeError';

  constructor(readonly maxBytes: number) {
    super(`Artifact exceeds the ${maxBytes}-byte limit`);
  }
}

export class BlobIntegrityError extends Error {
  override readonly name = 'BlobIntegrityError';

  constructor(
    readonly key: string,
    readonly expectedSha256: string,
    readonly actualSha256: string,
  ) {
    super(`Blob ${key} expected sha256 ${expectedSha256} but got ${actualSha256}`);
  }
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

/** Signals Task 4 to preserve failed work and converge the run terminally. */
export class EmergencyCeilingError extends Error {
  override readonly name = 'EmergencyCeilingError';
  readonly code = 'EMERGENCY_CEILING';

  constructor(
    readonly runId: string,
    readonly reason: 'active-time' | 'consecutive-repairs',
  ) {
    super(`Workflow run ${runId} reached the ${reason} emergency ceiling.`);
  }
}

/** A hard ProjectPolicy constraint was violated; the run must not proceed. */
export class PolicyViolationError extends Error {
  override readonly name = 'PolicyViolationError';
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

export class PreviewAccessDeniedError extends Error {
  override readonly name = 'PreviewAccessDeniedError';

  constructor(
    readonly sessionId: string,
    readonly reason: string,
  ) {
    super(`Preview session ${sessionId} denied: ${reason}`);
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

/** The exact provisional version changed or became protected before compensation acquired its lock. */
export class ProjectVersionDiscardRefusedError extends Error {
  override readonly name = 'ProjectVersionDiscardRefusedError';
  readonly code = 'PROJECT_VERSION_DISCARD_REFUSED';

  constructor(readonly versionId: string) {
    super(
      `Project version ${versionId} no longer matches the unpromoted version and cannot be discarded`,
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

/** Two different decisions were made for the same approval request. */
export class ApprovalConflictError extends Error {
  override readonly name = 'ApprovalConflictError';

  constructor(
    readonly runId: string,
    readonly requestId: string,
    readonly decision: ApprovalDecision,
  ) {
    super(
      `Approval request ${requestId} on run ${runId} was already decided as ` +
        `'${decision.action}' by ${decision.decidedBy}.`,
    );
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
