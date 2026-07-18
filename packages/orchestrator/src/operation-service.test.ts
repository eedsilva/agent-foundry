import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Operation, WorkflowRun } from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type IdGenerator,
  type JobQueue,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { OperationService } from './operation-service.js';

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

class MemoryConversations implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  readonly messages: Message[] = [];
  readonly operations: Operation[] = [];
  createConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.projectId, conversation);
    return Promise.resolve();
  }
  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(this.conversations.get(projectId) ?? null);
  }
  getSnapshot(projectId: string) {
    return Promise.resolve({
      conversation: this.conversations.get(projectId) ?? null,
      messages: this.messages,
      attachments: [],
      operations: this.operations,
    });
  }
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const stored = { ...message, sequence: this.messages.length + 1 };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }
  listMessages(projectId: string): Promise<Message[]> {
    return Promise.resolve(this.messages.filter((m) => m.projectId === projectId));
  }
  createAttachment(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  getAttachment(): Promise<null> {
    return Promise.resolve(null);
  }
  listAttachments(): Promise<never[]> {
    return Promise.resolve([]);
  }
  createOperation(operation: Operation): Promise<Operation> {
    this.operations.push(operation);
    return Promise.resolve(operation);
  }
  getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    return Promise.resolve(
      this.operations.find((o) => o.projectId === projectId && o.id === operationId) ?? null,
    );
  }
  updateOperation(operation: Operation): Promise<Operation> {
    const index = this.operations.findIndex((o) => o.id === operation.id);
    this.operations[index] = operation;
    return Promise.resolve(operation);
  }
  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(this.operations.filter((o) => o.projectId === projectId));
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
