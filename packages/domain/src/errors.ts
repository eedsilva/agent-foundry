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
    readonly entity: 'workflow-run' | 'step-run' | 'step-attempt',
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
