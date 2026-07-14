import { mkdtemp, rm } from 'node:fs/promises';
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

  it('rejects a stale fencingToken from the crashed worker after another worker reclaims the job', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    const staleClaim = (await queue.claim('worker-a'))!;
    expect(staleClaim.lease?.fencingToken).toBe(1);

    clock.advanceMs(61_000);
    const [recovered] = await queue.reapExpired();
    expect(recovered).toBeDefined();

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

  it('dead worker: expired lease is reaped and redelivery completes the run exactly once', async () => {
    const dataDir = await temporaryDataDir();
    const clock = new FakeClock(new Date(createdAt));
    const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
    await queue.enqueue({ ...baseJob(), runId: 'run-1' });

    // Delivering the same runId twice must execute the underlying run once:
    // the effect is idempotent, mirroring the orchestrator's terminal-run guard.
    const executions: string[] = [];
    const runOnce = (runId: string): void => {
      if (!executions.includes(runId)) executions.push(runId);
    };

    // worker-a claims and runs the job, then dies before acking (no heartbeat).
    const workerA = (await queue.claim('worker-a'))!;
    runOnce(workerA.runId!);

    // Past the lease, the reaper returns the job to pending.
    clock.advanceMs(60_001);
    const [recovered] = await queue.reapExpired();
    expect(recovered?.runId).toBe('run-1');

    // worker-b reclaims (fresh fencing token), re-runs the idempotent job, acks.
    const workerB = (await queue.claim('worker-b'))!;
    expect(workerB.lease?.fencingToken).toBe(2);
    runOnce(workerB.runId!);
    await queue.ack(workerB, 'worker-b');

    // The run executed exactly once despite the redelivery.
    expect(executions).toEqual(['run-1']);

    // The job completed exactly once: nothing left to claim or reap.
    expect(await queue.claim('worker-c')).toBeNull();
    expect(await queue.reapExpired()).toHaveLength(0);

    // The dead worker's stale copy can neither heartbeat nor ack.
    await expect(queue.heartbeat(workerA, 'worker-a')).rejects.toThrow(LeaseLostError);
    await expect(queue.ack(workerA, 'worker-a')).rejects.toThrow(LeaseLostError);
  });
});
