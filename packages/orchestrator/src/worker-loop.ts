import type { JobQueue } from '@agent-foundry/domain';
import { errorMessage } from '@agent-foundry/domain';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';

export interface WorkerLoopOptions {
  workerId: string;
  pollIntervalMs: number;
}

export class WorkerLoop {
  private stopped = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly options: WorkerLoopOptions,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim(this.options.workerId);
    if (!job) return false;

    try {
      await this.orchestrator.runProject(job.projectId, job.workflowId);
      await this.queue.ack(job, this.options.workerId);
    } catch (error) {
      await this.queue.nack(
        job,
        this.options.workerId,
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
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
