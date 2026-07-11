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
