import { describe, expect, it } from 'vitest';
import type { ProjectEvent, QueueJob } from '@agent-foundry/contracts';
import type { Clock, EventStore, IdGenerator, JobQueue } from '@agent-foundry/domain';
import { QueueLeaseReaper } from './queue-lease-reaper.js';

class FakeClock implements Clock {
  constructor(private current = new Date('2026-07-14T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

class InMemoryEventStore implements EventStore {
  readonly events: ProjectEvent[] = [];
  append(event: ProjectEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
  list(projectId: string): Promise<ProjectEvent[]> {
    return Promise.resolve(this.events.filter((event) => event.projectId === projectId));
  }
}

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
    leaseEpoch: 2,
    ...overrides,
  };
}

class StubJobQueue implements JobQueue {
  constructor(private readonly recoveredJobs: QueueJob[]) {}
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
  claim(): Promise<QueueJob | null> {
    return Promise.resolve(null);
  }
  heartbeat(current: QueueJob): Promise<QueueJob> {
    return Promise.resolve(current);
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  nack(): Promise<void> {
    return Promise.resolve();
  }
  reapExpired(): Promise<QueueJob[]> {
    return Promise.resolve(this.recoveredJobs);
  }
}

describe('QueueLeaseReaper', () => {
  it('emits one queue.job_recovered event per job recovered by the queue', async () => {
    const events = new InMemoryEventStore();
    const queue = new StubJobQueue([
      job({ id: 'job-1', projectId: 'project-1', runId: 'run-1' }),
      job({ id: 'job-2', projectId: 'project-2' }),
    ]);
    const reaper = new QueueLeaseReaper(queue, events, new FakeClock(), new SequentialIds(), {
      intervalMs: 1_000,
    });

    const count = await reaper.reapOnce();

    expect(count).toBe(2);
    expect(events.events).toHaveLength(2);
    expect(events.events[0]).toMatchObject({
      projectId: 'project-1',
      runId: 'run-1',
      type: 'queue.job_recovered',
      data: { jobId: 'job-1' },
    });
    expect(events.events[1]).toMatchObject({ projectId: 'project-2', type: 'queue.job_recovered' });
    expect(events.events[1]?.runId).toBeUndefined();
  });

  it('emits nothing when there is nothing to recover', async () => {
    const events = new InMemoryEventStore();
    const queue = new StubJobQueue([]);
    const reaper = new QueueLeaseReaper(queue, events, new FakeClock(), new SequentialIds(), {
      intervalMs: 1_000,
    });

    expect(await reaper.reapOnce()).toBe(0);
    expect(events.events).toHaveLength(0);
  });

  it('stops the polling loop when stop() is called', async () => {
    const events = new InMemoryEventStore();
    const queue = new StubJobQueue([job()]);
    const reaper = new QueueLeaseReaper(queue, events, new FakeClock(), new SequentialIds(), {
      intervalMs: 5,
    });

    const runPromise = reaper.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    reaper.stop();
    await runPromise;

    expect(events.events.length).toBeGreaterThan(0);
  });
});
