import type { QueueJob } from '@agent-foundry/contracts';
import type { JobQueue } from '@agent-foundry/domain';
import {
  LeaseLostError,
  errorMessage,
  recordQueueWait,
  withExtractedContext,
  withSpan,
} from '@agent-foundry/domain';
import type { ConversationOperationRunner } from './conversation-operation-runner.js';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';

/** Structural — deliberately not `pino.Logger` so orchestrator stays free of a pino dependency; apps/worker passes a real pino child-logger factory in. */
export interface JobLogger {
  child(bindings: Record<string, unknown>): JobLogger;
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface WorkerLoopOptions {
  workerId: string;
  pollIntervalMs: number;
  heartbeatIntervalMs?: number;
  logger?: JobLogger;
}

interface HeartbeatState {
  job: QueueJob;
  leaseLost: boolean;
}

export class WorkerLoop {
  private stopped = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly operationRunner: ConversationOperationRunner,
    private readonly options: WorkerLoopOptions,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim(this.options.workerId);
    if (!job) return false;

    const state: HeartbeatState = { job, leaseLost: false };
    const leaseAbort = new AbortController();
    const stopHeartbeat = this.startHeartbeat(state, leaseAbort);
    const queueWaitMs = Date.now() - Date.parse(job.availableAt);
    recordQueueWait(queueWaitMs);
    const log = this.options.logger?.child({
      jobId: job.id,
      runId: job.runId,
      projectId: job.projectId,
    });

    try {
      await withExtractedContext(job.traceContext, () =>
        withSpan(
          'foundry.job',
          {
            'foundry.job.id': job.id,
            'foundry.job.type': job.type,
            'foundry.job.attempts': job.attempts,
            'foundry.queue.wait_ms': queueWaitMs,
          },
          async () => {
            if (job.type === 'run-project') {
              await this.orchestrator.runProject(
                job.projectId,
                job.workflowId,
                job.runId,
                leaseAbort.signal,
              );
            } else {
              if (!job.runId || !job.operationId) {
                throw new Error(
                  `run-conversation-operation job ${job.id} is missing runId/operationId`,
                );
              }
              await this.operationRunner.run(job.projectId, job.runId, job.operationId);
            }
          },
        ),
      );
      stopHeartbeat();
      if (!state.leaseLost) await this.queue.ack(state.job, this.options.workerId);
      log?.info('job completed');
    } catch (error) {
      stopHeartbeat();
      if (!state.leaseLost) {
        await this.queue.nack(
          state.job,
          this.options.workerId,
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
      }
      log?.error({ err: error }, 'job failed');
    }
    return true;
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    while (!this.stopped && !signal?.aborted) {
      const worked = await this.runOnce();
      if (!worked) await sleep(this.options.pollIntervalMs, signal);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Renews the lease while runProject executes, self-rescheduling only after
   * each heartbeat settles so calls never overlap. Lease loss stops the run;
   * transient failures retry on the next interval.
   */
  private startHeartbeat(state: HeartbeatState, leaseAbort: AbortController): () => void {
    const intervalMs = this.options.heartbeatIntervalMs ?? 15_000;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = (): void => {
      if (stopped) return;
      timer = setTimeout(() => {
        void this.queue
          .heartbeat(state.job, this.options.workerId)
          .then((renewed) => {
            state.job = renewed;
            tick();
          })
          .catch((error: unknown) => {
            if (error instanceof LeaseLostError) {
              state.leaseLost = true;
              leaseAbort.abort(error);
              return;
            }
            tick();
          });
      }, intervalMs);
    };
    tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
