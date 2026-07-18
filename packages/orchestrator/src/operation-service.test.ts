import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type IdGenerator,
  type JobQueue,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { OperationService } from './operation-service.js';
import { MemoryConversations } from './testing/harness.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-18T12:00:00.000Z');
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class MemoryRuns implements WorkflowRunRepository {
  readonly store = new Map<string, WorkflowRun>();
  create(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, run);
    return Promise.resolve();
  }
  get(runId: string): Promise<WorkflowRun | null> {
    return Promise.resolve(this.store.get(runId) ?? null);
  }
  list(): Promise<WorkflowRun[]> {
    return Promise.resolve([...this.store.values()]);
  }
  update(run: WorkflowRun): Promise<WorkflowRun> {
    this.store.set(run.id, run);
    return Promise.resolve(run);
  }
}

class MemoryQueue implements JobQueue {
  readonly enqueued: Array<Parameters<JobQueue['enqueue']>[0]> = [];
  enqueue(job: Parameters<JobQueue['enqueue']>[0]): Promise<void> {
    this.enqueued.push(job);
    return Promise.resolve();
  }
  claim(): Promise<null> {
    return Promise.resolve(null);
  }
  heartbeat(job: Parameters<JobQueue['enqueue']>[0]): Promise<Parameters<JobQueue['enqueue']>[0]> {
    return Promise.resolve(job);
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  nack(): Promise<void> {
    return Promise.resolve();
  }
  reapExpired(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function noArtifacts(): ArtifactStore {
  return {
    put: () => Promise.reject(new Error('not used in start()')),
    putBlob: () => Promise.reject(new Error('not used')),
    getBlobStream: () => Promise.resolve(null),
    getLatest: () => Promise.resolve(null),
    getRevision: () => Promise.resolve(null),
    listLatest: () => Promise.resolve([]),
    listMetadata: () => Promise.resolve([]),
  };
}

async function seedMessage(conversations: MemoryConversations, projectId = 'project-1') {
  await conversations.createConversation({
    id: projectId,
    projectId,
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  return conversations.appendMessage({
    id: 'message-1',
    projectId,
    conversationId: projectId,
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
}

describe('OperationService.start', () => {
  it('creates a queued plan operation, run, and job', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );

    const operation = await service.start('project-1', message.id, { kind: 'plan' });

    expect(operation).toMatchObject({ kind: 'plan', approval: { status: 'pending' } });
    expect(operation.runId).toBeDefined();
    expect((await runs.get(operation.runId!))?.status).toBe('queued');
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      type: 'run-conversation-operation',
      operationId: operation.id,
      runId: operation.runId,
    });
  });

  it('rejects a build request with neither planOperationId nor directExecution', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );

    await expect(
      service.start('project-1', message.id, { kind: 'build' } as never),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a build referencing a plan that is not approved', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(
      service.start('project-1', message.id, { kind: 'build', planOperationId: plan.id }),
    ).rejects.toThrow(ValidationError);
  });

  it('copies the approved plan artifact references onto the build operation', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const reference = { name: 'plan-proposal', revision: 1, sha256: 'a'.repeat(64) };
    await conversations.updateOperation({
      ...plan,
      approval: { status: 'approved', decidedAt: '2026-07-18T12:05:00.000Z' },
      artifactReferences: [reference],
    });

    const build = await service.start('project-1', message.id, {
      kind: 'build',
      planOperationId: plan.id,
    });

    expect(build.artifactReferences).toEqual([reference]);
  });

  it('creates a direct-execution build operation without a plan', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );

    const build = await service.start('project-1', message.id, {
      kind: 'build',
      directExecution: true,
    });

    expect(build).toMatchObject({ kind: 'build', directExecution: true, artifactReferences: [] });
  });

  it('rejects an unknown message', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );

    await expect(service.start('project-1', 'missing', { kind: 'plan' })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe('OperationService.decide', () => {
  async function startAndCompletePlan(
    conversations: MemoryConversations,
    runs: MemoryRuns,
    queue: MemoryQueue,
    artifacts: ArtifactStore,
  ) {
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      artifacts,
      new FixedClock(),
      new SequentialIds(),
    );
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'running' });
    await runs.update({ ...run, status: 'completed' });
    return { service, plan };
  }

  it('rejects deciding a plan whose run has not completed', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(service.decide('project-1', plan.id, 'approve')).rejects.toThrow(ValidationError);
  });

  it('approving derives artifactReferences from the completed run artifact', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const artifacts: ArtifactStore = {
      put: () => Promise.reject(new Error('not used')),
      putBlob: () => Promise.reject(new Error('not used')),
      getBlobStream: () => Promise.resolve(null),
      getLatest: (projectId, name) =>
        Promise.resolve({
          metadata: {
            projectId,
            name,
            revision: 1,
            contentType: 'application/json',
            createdAt: '2026-07-18T12:00:00.000Z',
            createdBy: 'planner:mock/mock',
            sha256: 'b'.repeat(64),
          },
          content: { schemaVersion: '1', summary: 'toggle plan' },
        }),
      getRevision: () => Promise.resolve(null),
      listLatest: () => Promise.resolve([]),
      listMetadata: () => Promise.resolve([]),
    };
    const { service, plan } = await startAndCompletePlan(conversations, runs, queue, artifacts);

    const approved = await service.decide('project-1', plan.id, 'approve');

    expect(approved.approval).toMatchObject({ status: 'approved' });
    expect(approved.artifactReferences).toEqual([
      { name: `operation-${plan.id}`, revision: 1, sha256: 'b'.repeat(64) },
    ]);
  });

  it('rejecting sets approval.status without touching artifactReferences', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const { service, plan } = await startAndCompletePlan(conversations, runs, queue, noArtifacts());

    const rejected = await service.decide('project-1', plan.id, 'reject');

    expect(rejected.approval).toMatchObject({ status: 'rejected' });
    expect(rejected.artifactReferences).toEqual([]);
  });

  it('rejects deciding a non-plan operation', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(
      conversations,
      runs,
      queue,
      noArtifacts(),
      new FixedClock(),
      new SequentialIds(),
    );
    const build = await service.start('project-1', message.id, {
      kind: 'build',
      directExecution: true,
    });

    await expect(service.decide('project-1', build.id, 'approve')).rejects.toThrow(ValidationError);
  });
});
