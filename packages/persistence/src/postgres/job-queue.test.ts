import { describe, expect, it } from 'vitest';
import type { QueueJob } from '@agent-foundry/contracts';
import { LeaseLostError, type Clock } from '@agent-foundry/domain';
import { describePostgres } from './testing.js';
import { PostgresJobQueue } from './job-queue.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const createdAt = '2026-07-14T12:00:00.000Z';

function baseJob(id = 'job-1'): QueueJob {
  return {
    id,
    type: 'run-project',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    attempts: 0,
    maxAttempts: 3,
    createdAt,
    availableAt: createdAt,
    leaseEpoch: 0,
  };
}

describePostgres('PostgresJobQueue', (ctx) => {
  it('claim returns null when there are no pending jobs', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    expect(await queue.claim('worker-a')).toBeNull();
  });

  it('enqueues and claims the earliest available job, granting a lease with fencing token 1', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    const claimed = await queue.claim('worker-a');

    expect(claimed?.id).toBe('job-1');
    expect(claimed?.lease?.workerId).toBe('worker-a');
    expect(claimed?.lease?.fencingToken).toBe(1);
    expect(claimed?.leaseEpoch).toBe(1);
  });

  it('does not claim a job whose availableAt is in the future', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue({
      ...baseJob(),
      availableAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });

    expect(await queue.claim('worker-a')).toBeNull();
  });

  it('two workers claiming concurrently get disjoint jobs (FOR UPDATE SKIP LOCKED)', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob('job-1'));
    await queue.enqueue(baseJob('job-2'));

    const [a, b] = await Promise.all([queue.claim('worker-a'), queue.claim('worker-b')]);

    const ids = [a?.id, b?.id].sort();
    expect(ids).toEqual(['job-1', 'job-2']);
    expect(await queue.claim('worker-c')).toBeNull();
  });

  it('enqueue is idempotent on a duplicate id', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    await queue.enqueue(baseJob());

    await queue.claim('worker-a');
    expect(await queue.claim('worker-b')).toBeNull();
  });

  it('heartbeat renews the lease and rejects a stale fencing token with LeaseLostError', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    clock.advanceMs(1_000);
    const renewed = await queue.heartbeat(claimed!, 'worker-a');
    expect(renewed.lease?.heartbeatAt).not.toBe(claimed!.lease?.heartbeatAt);

    await expect(queue.heartbeat(claimed!, 'worker-b')).rejects.toThrow(LeaseLostError);
  });

  it('ack marks the job completed and rejects a lost lease', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await expect(queue.ack(claimed!, 'worker-b')).rejects.toThrow(LeaseLostError);
    await queue.ack(claimed!, 'worker-a');

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('completed');
  });

  it('nack increments attempts, reschedules with backoff, and clears the lease', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('transient'));

    const [row] = await ctx.db()<{ status: string; attempts: number; worker_id: string | null }[]>`
      select status, attempts, worker_id from jobs where id = 'job-1'`;
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.worker_id).toBeNull();
  });

  it('nack dead-letters once maxAttempts is exhausted', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue({ ...baseJob(), attempts: 2, maxAttempts: 3 });
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('final failure'));

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('failed');
  });

  it('nack({ permanent: true }) dead-letters immediately regardless of attempts', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('unrecoverable'), { permanent: true });

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('failed');
  });

  it('reapExpired reclaims a processing job past its lease and bumps the epoch so the old worker is fenced out', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    clock.advanceMs(61_000);
    const recovered = await queue.reapExpired();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe('job-1');

    const reclaimed = await queue.claim('worker-b');
    expect(reclaimed?.lease?.fencingToken).toBe(2);
    await expect(queue.heartbeat(claimed!, 'worker-a')).rejects.toThrow(LeaseLostError);
  });
});
