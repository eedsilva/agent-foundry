import type { Clock, EventStore, IdGenerator, JobQueue } from '@agent-foundry/domain';

export interface QueueLeaseReaperOptions {
  intervalMs: number;
}

/**
 * Periodically reclaims processing jobs whose lease expired — the recovery
 * path for a worker that crashed or lost connectivity between claim and
 * ack/nack. Emits one queue.job_recovered event per recovered job so the
 * recovery is visible in the project timeline.
 */
export class QueueLeaseReaper {
  private stopped = false;

  constructor(
    private readonly queue: JobQueue,
    private readonly events: EventStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: QueueLeaseReaperOptions,
  ) {}

  async reapOnce(): Promise<number> {
    const recovered = await this.queue.reapExpired();
    for (const job of recovered) {
      await this.events.append({
        id: this.ids.next(),
        projectId: job.projectId,
        type: 'queue.job_recovered',
        createdAt: this.clock.now().toISOString(),
        ...(job.runId ? { runId: job.runId } : {}),
        message: `Job ${job.id} recovered after its lease expired without a heartbeat.`,
        data: { jobId: job.id, attempts: job.attempts, leaseEpoch: job.leaseEpoch },
      });
    }
    return recovered.length;
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    while (!this.stopped && !signal?.aborted) {
      await this.reapOnce();
      await sleep(this.options.intervalMs, signal);
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
