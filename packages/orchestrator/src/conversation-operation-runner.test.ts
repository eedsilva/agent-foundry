import { describe, expect, it } from 'vitest';
import type {
  ArtifactStore,
  Clock,
  ConversationRepository,
  EventStore,
  ExecutorRegistry,
  HarnessRepository,
  IdGenerator,
  MetricsRepository,
  ModelRouter,
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import type { Conversation, Message, Operation, WorkflowRun } from '@agent-foundry/contracts';
import {
  ControllableExecutor,
  FakeWorkspaces,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryRuns,
  InMemoryStepAttempts,
  InMemoryStepRuns,
  MODELS,
} from './testing/harness.js';
import { ConversationOperationRunner } from './conversation-operation-runner.js';

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
  private readonly messages: Message[] = [];
  private readonly operations: Operation[] = [];
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
      messages: this.messages.filter((m) => m.projectId === projectId),
      attachments: [],
      operations: this.operations.filter((o) => o.projectId === projectId),
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
    return Promise.reject(new Error('not used in this test'));
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

const harnessRepo: HarnessRepository = {
  select: () => Promise.resolve({ version: 'v1', files: [], combined: '' }),
  version: () => Promise.resolve('v1'),
};
const metrics: MetricsRepository = {
  get: () => Promise.resolve(null),
  record: () => Promise.resolve(),
  recordQuality: () => Promise.resolve(),
};
const router: ModelRouter = {
  route: (profile) =>
    Promise.resolve({
      routeId: 'route-1',
      createdAt: '2026-07-18T12:00:00.000Z',
      profile,
      selected: {
        model: MODELS[0]!,
        score: {
          capability: 1,
          context: 1,
          speed: 1,
          cost: 1,
          reliability: 1,
          historical: 1,
          tagAffinity: 1,
          estimatedCostUsd: 0,
          total: 1,
        },
      },
      fallbacks: [],
      rejected: [],
    }),
  catalog: () => Promise.resolve(MODELS),
};

function setup() {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    harnessRepo,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    new FixedClock(),
    new SequentialIds(),
    { agentTimeoutMs: 60_000 },
  );
  return { runs, stepRuns, stepAttempts, artifacts, events, workspaces, conversations, runner };
}

async function seed(
  conversations: MemoryConversations,
  runs: WorkflowRunRepository,
  kind: 'plan' | 'build',
): Promise<{ runId: string; operationId: string }> {
  await conversations.createConversation({
    id: 'project-1',
    projectId: 'project-1',
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  await conversations.appendMessage({
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  const runId = 'run-1';
  const operationId = 'operation-1';
  await runs.create({
    id: runId,
    projectId: 'project-1',
    workflowId: `conversation-${kind}`,
    status: 'queued',
    version: 1,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
  });
  await conversations.createOperation({
    id: operationId,
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    kind,
    idempotencyKey: 'a'.repeat(64),
    runId,
    artifactReferences: [],
    ...(kind === 'plan'
      ? { approval: { status: 'pending' as const } }
      : { directExecution: true as const }),
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  return { runId, operationId };
}

describe('ConversationOperationRunner', () => {
  it('completes a plan operation without touching the workspace', async () => {
    const { runs, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'plan');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.commits).toEqual([]);
    expect(await artifacts.getLatest('project-1', `operation-${operationId}`)).not.toBeNull();
  });

  it('completes a build operation and commits the touched workspace', async () => {
    const { runs, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    expect(await artifacts.getLatest('project-1', `operation-${operationId}`)).not.toBeNull();
  });

  it('marks the run failed and rolls back the checkpoint when the executor fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('boom');
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(workspaces.commits).toEqual([]);
  });

  it('keeps the completed run and commit intact when appending the completion event fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true });
    events.onBeforeAppend = () => {
      throw new Error('event store unavailable');
    };
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor({}, workspaces);
    const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    // run() must resolve (not throw) even though the post-completion event
    // append failed, and the already-durable success must not be undone.
    await expect(runner.run('project-1', runId, operationId)).resolves.toBeUndefined();

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('completed');
    expect(workspaces.rollbacks).toEqual([]);
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    expect(await artifacts.getLatest('project-1', `operation-${operationId}`)).not.toBeNull();
  });
});
