import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { QueueJob } from '@agent-foundry/contracts';
import {
  currentTraceIds,
  LeaseLostError,
  serializeTraceContext,
  withSpan,
  type JobQueue,
} from '@agent-foundry/domain';
import { WorkerLoop, type JobLogger } from './worker-loop.js';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';

function job(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: 'job-1',
    type: 'run-project',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    attempts: 0,
    maxAttempts: 3,
    createdAt: '2026-07-14T12:00:00.000Z',
    availableAt: '2026-07-14T12:00:00.000Z',
    leaseEpoch: 1,
    lease: {
      workerId: 'worker-a',
      fencingToken: 1,
      heartbeatAt: '2026-07-14T12:00:00.000Z',
      expiresAt: '2026-07-14T12:01:00.000Z',
    },
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeQueue(overrides: Partial<JobQueue> = {}): JobQueue {
  return {
    enqueue: vi.fn(),
    claim: vi.fn().mockResolvedValue(null),
    heartbeat: vi.fn(),
    ack: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
    reapExpired: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// Structural fake matching JobLogger — child() returns itself so call sites
// (job.child({...}).info(...)) are observable via the same spies.
function fakeLogger(): JobLogger & {
  child: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const info = vi.fn();
  const error = vi.fn();
  const logger = { child: vi.fn(), info, error };
  logger.child.mockReturnValue(logger);
  return logger;
}

function fakeOperationRunner(
  run: (projectId: string, runId: string, operationId: string) => Promise<void> = () =>
    Promise.resolve(),
) {
  return {
    run,
  } as unknown as import('./conversation-operation-runner.js').ConversationOperationRunner;
}

describe('WorkerLoop heartbeat renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renews the lease on an interval while the project runs and acks with the latest job', async () => {
    const initialJob = job();
    const renewedJob = job({
      lease: { ...initialJob.lease!, heartbeatAt: '2026-07-14T12:00:00.200Z' },
    });
    const heartbeat = vi.fn().mockResolvedValue(renewedJob);
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(initialJob), heartbeat });

    const run = deferred<void>();
    const runProject = vi.fn().mockReturnValue(run.promise);
    const orchestrator = { runProject } as unknown as WorkflowOrchestrator;

    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 100,
    });

    const runOncePromise = worker.runOnce();

    await vi.advanceTimersByTimeAsync(250);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(heartbeat).toHaveBeenNthCalledWith(1, initialJob, 'worker-a');
    expect(heartbeat).toHaveBeenNthCalledWith(2, renewedJob, 'worker-a');

    run.resolve();
    await runOncePromise;

    expect(queue.ack).toHaveBeenCalledTimes(1);
    expect(queue.ack).toHaveBeenCalledWith(renewedJob, 'worker-a');
    expect(queue.nack).not.toHaveBeenCalled();

    const callsAfterCompletion = heartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(heartbeat.mock.calls.length).toBe(callsAfterCompletion);
  });

  it('skips ack when a heartbeat reports the lease was lost mid-run', async () => {
    const initialJob = job();
    const heartbeat = vi.fn().mockRejectedValue(new LeaseLostError('job-1', 'worker-a'));
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(initialJob), heartbeat });

    const run = deferred<void>();
    const orchestrator = {
      runProject: vi.fn().mockReturnValue(run.promise),
    } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 100,
    });

    const runOncePromise = worker.runOnce();
    await vi.advanceTimersByTimeAsync(150);
    expect(heartbeat).toHaveBeenCalledTimes(1);

    run.resolve();
    await runOncePromise;

    expect(queue.ack).not.toHaveBeenCalled();
    expect(queue.nack).not.toHaveBeenCalled();
  });

  it('nacks with the run error and the latest heartbeat-renewed job when the run fails', async () => {
    const initialJob = job();
    const renewedJob = job({
      lease: { ...initialJob.lease!, heartbeatAt: '2026-07-14T12:00:00.200Z' },
    });
    const heartbeat = vi.fn().mockResolvedValue(renewedJob);
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(initialJob), heartbeat });

    const run = deferred<void>();
    const orchestrator = {
      runProject: vi.fn().mockReturnValue(run.promise),
    } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 100,
    });

    const runOncePromise = worker.runOnce();
    await vi.advanceTimersByTimeAsync(150);
    run.reject(new Error('boom'));
    await runOncePromise;

    expect(queue.nack).toHaveBeenCalledTimes(1);
    expect(queue.nack).toHaveBeenCalledWith(
      renewedJob,
      'worker-a',
      expect.objectContaining({ message: 'boom' }),
    );
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it('returns false and starts no heartbeat when there is no job to claim', async () => {
    const heartbeat = vi.fn();
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(null), heartbeat });
    const orchestrator = { runProject: vi.fn() } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
    });

    expect(await worker.runOnce()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('dispatches a run-conversation-operation job to the operation runner, not runProject', async () => {
    const queue = fakeQueue({
      claim: vi
        .fn()
        .mockResolvedValueOnce(
          job({ type: 'run-conversation-operation', runId: 'run-1', operationId: 'operation-1' }),
        )
        .mockResolvedValue(null),
    });
    const runProject = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { runProject } as unknown as WorkflowOrchestrator;
    const run = vi.fn().mockResolvedValue(undefined);
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(run), {
      workerId: 'worker-a',
      pollIntervalMs: 10,
    });

    await worker.runOnce();

    expect(run).toHaveBeenCalledWith('project-1', 'run-1', 'operation-1');
    expect(runProject).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalled();
  });
});

describe('WorkerLoop job logger', () => {
  it('scopes a child logger to jobId/runId/projectId and logs completion on success', async () => {
    const claimedJob = job({ id: 'job-9', runId: 'run-9', projectId: 'project-9' });
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });
    const orchestrator = {
      runProject: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowOrchestrator;
    const logger = fakeLogger();

    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
      logger,
    });

    await worker.runOnce();

    expect(logger.child).toHaveBeenCalledWith({
      jobId: 'job-9',
      runId: 'run-9',
      projectId: 'project-9',
    });
    expect(logger.info).toHaveBeenCalledWith('job completed');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('scopes a child logger to jobId/runId/projectId and logs failure when the run throws', async () => {
    const claimedJob = job({ id: 'job-9', runId: 'run-9', projectId: 'project-9' });
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });
    const orchestrator = {
      runProject: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as WorkflowOrchestrator;
    const logger = fakeLogger();

    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
      logger,
    });

    await worker.runOnce();

    expect(logger.child).toHaveBeenCalledWith({
      jobId: 'job-9',
      runId: 'run-9',
      projectId: 'project-9',
    });
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'boom' }) },
      'job failed',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('WorkerLoop job span trace propagation', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('links the dispatched job span to the trace that enqueued the job', async () => {
    let enqueuingTraceId = '';
    let carrier: Record<string, string> = {};
    await withSpan('foundry.request', {}, async (span) => {
      enqueuingTraceId = span.spanContext().traceId;
      carrier = serializeTraceContext();
    });
    expect(enqueuingTraceId).not.toBe('');

    const claimedJob = job({ traceContext: carrier });
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });

    let dispatchedTraceId = '';
    const orchestrator = {
      runProject: vi.fn().mockImplementation(async () => {
        dispatchedTraceId = currentTraceIds().traceId ?? '';
      }),
    } as unknown as WorkflowOrchestrator;

    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
    });

    await worker.runOnce();

    expect(dispatchedTraceId).toBe(enqueuingTraceId);
    expect(queue.ack).toHaveBeenCalled();
  });
});
