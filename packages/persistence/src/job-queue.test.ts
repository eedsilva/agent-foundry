import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueJob } from '@agent-foundry/contracts';
import { LeaseLostError, type Clock } from '@agent-foundry/domain';
import { FileJobQueue } from './job-queue.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-queue-'));
  temporaryDirectories.push(path);
  return path;
}

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

describe('FileJobQueue lease semantics', () => {
  it('publishes despite an orphaned enqueue lock directory from a hard crash', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await mkdir(join(dataDir, 'queue', 'enqueue-locks', 'job-1.lock'), { recursive: true });

    await queue.enqueue(baseJob());

    expect((await queue.claim('worker-a'))?.id).toBe('job-1');
    expect(await queue.claim('worker-b')).toBeNull();
  }, 15_000);

  it('publishes one pending job when identical enqueues race', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });

    await Promise.all([queue.enqueue(baseJob()), queue.enqueue(baseJob())]);

    expect((await queue.claim('worker-a'))?.id).toBe('job-1');
    expect(await queue.claim('worker-b')).toBeNull();
  });

  it('keeps the first pending job when the same id is enqueued again', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    await queue.enqueue({ ...baseJob(), projectId: 'project-2' });

    const claimed = await queue.claim('worker-a');
    expect(claimed?.projectId).toBe('project-1');
    expect(await queue.claim('worker-b')).toBeNull();
  });

  it('does not publish a duplicate while the same job id has an active lease', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = (await queue.claim('worker-a'))!;

    await queue.enqueue({ ...baseJob(), projectId: 'project-2' });

    expect(await queue.claim('worker-b')).toBeNull();
    await expect(queue.heartbeat(claimed, 'worker-a')).resolves.toMatchObject({
      projectId: 'project-1',
      lease: { workerId: 'worker-a' },
    });
  });

  it('grants a lease with workerId, heartbeatAt, expiresAt, and a monotonic fencingToken on claim', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    const claimed = await queue.claim('worker-a');
    expect(claimed).not.toBeNull();
    expect(claimed?.lease).toMatchObject({
      workerId: 'worker-a',
      fencingToken: 1,
      heartbeatAt: createdAt,
    });
    expect(claimed?.lease?.expiresAt).toBe('2026-07-14T12:01:00.000Z');
    expect(claimed?.leaseEpoch).toBe(1);
  });

  it('renews the heartbeat and extends expiresAt while the worker is running', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = (await queue.claim('worker-a'))!;

    clock.advanceMs(30_000);
    const renewed = await queue.heartbeat(claimed, 'worker-a');
    expect(renewed.lease?.heartbeatAt).toBe('2026-07-14T12:00:30.000Z');
    expect(renewed.lease?.expiresAt).toBe('2026-07-14T12:01:30.000Z');
    expect(renewed.lease?.fencingToken).toBe(1);
  });

  it('recovers an expired job back to pending after a simulated worker crash', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    // worker-a claims and then crashes: no heartbeat, no ack, no nack.
    const claimed = (await queue.claim('worker-a'))!;
    expect(claimed.lease?.workerId).toBe('worker-a');

    // Before the lease expires, the reaper must leave it alone.
    clock.advanceMs(59_000);
    expect(await queue.reapExpired()).toHaveLength(0);

    // Past expiry, the reaper recovers it.
    clock.advanceMs(2_000);
    const recovered = await queue.reapExpired();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe('job-1');
    expect(recovered[0]?.lease).toBeUndefined();

    // The job is claimable again by a healthy worker.
    const reclaimed = await queue.claim('worker-b');
    expect(reclaimed).not.toBeNull();
    expect(reclaimed?.lease?.workerId).toBe('worker-b');
    expect(reclaimed?.lease?.fencingToken).toBe(2);
  });

  it("recovers a dead worker's expired lease and fences out the stale claimant", async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue({ ...baseJob(), runId: 'run-1' });

    // worker-a claims the job, then dies before acking (no heartbeat).
    const staleClaim = (await queue.claim('worker-a'))!;
    expect(staleClaim.lease?.fencingToken).toBe(1);

    // Past the lease, the reaper recovers it; the job's runId survives.
    clock.advanceMs(61_000);
    const [recovered] = await queue.reapExpired();
    expect(recovered).toBeDefined();
    expect(recovered?.runId).toBe('run-1');

    const freshClaim = (await queue.claim('worker-b'))!;
    expect(freshClaim.lease?.fencingToken).toBe(2);

    // worker-a is still alive but its token is obsolete: heartbeat, ack, and
    // nack must all reject it so it cannot corrupt worker-b's ownership.
    await expect(queue.heartbeat(staleClaim, 'worker-a')).rejects.toThrow(LeaseLostError);
    await expect(queue.ack(staleClaim, 'worker-a')).rejects.toThrow(LeaseLostError);
    await expect(queue.nack(staleClaim, 'worker-a', new Error('boom'))).rejects.toThrow(
      LeaseLostError,
    );

    // worker-b, the legitimate holder, can still complete the job.
    await expect(queue.ack(freshClaim, 'worker-b')).resolves.toBeUndefined();

    // The job is done at the queue level: nothing left to claim or reap.
    expect(await queue.claim('worker-c')).toBeNull();
    expect(await queue.reapExpired()).toHaveLength(0);
  });

  it('rejects ack/nack from a worker whose lease was reassigned to another worker directly', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    const workerA = (await queue.claim('worker-a'))!;
    clock.advanceMs(61_000);
    await queue.reapExpired();
    const workerB = (await queue.claim('worker-b'))!;
    expect(workerB.lease?.fencingToken).toBeGreaterThan(workerA.lease!.fencingToken);

    await expect(queue.ack(workerA, 'worker-a')).rejects.toThrow(LeaseLostError);
    await expect(queue.nack(workerB, 'worker-a', new Error('wrong worker'))).rejects.toThrow(
      LeaseLostError,
    );
  });

  it('clears the lease and returns a nacked job to pending with backoff', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = (await queue.claim('worker-a'))!;

    await queue.nack(claimed, 'worker-a', new Error('transient failure'));

    const reclaimed = await queue.claim('worker-a');
    expect(reclaimed).toBeNull(); // still backing off, availableAt is in the future

    clock.advanceMs(10_000);
    const retried = await queue.claim('worker-a');
    expect(retried?.attempts).toBe(1);
    expect(retried?.lastError).toBe('transient failure');
    expect(retried?.lease?.fencingToken).toBe(2);
  });

  it('moves a job to failed once maxAttempts is exhausted, releasing the lease', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue({ ...baseJob(), maxAttempts: 1 });
    const claimed = (await queue.claim('worker-a'))!;

    await queue.nack(claimed, 'worker-a', new Error('fatal'));

    expect(await queue.claim('worker-a')).toBeNull();
    clock.advanceMs(60_000);
    expect(await queue.claim('worker-a')).toBeNull(); // failed, not pending
  });
});
