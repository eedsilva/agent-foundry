import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Operation } from '@agent-foundry/contracts';
import {
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import {
  ControllableAgentExecutor,
  AgentExecutorFromExecutionPlane,
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
import { OperationService } from './operation-service.js';

class FixedClock implements Clock {
  private tick = 0;
  now(): Date {
    this.tick += 1;
    return new Date(2026, 6, 18, 12, 0, this.tick);
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

class MemoryQueue implements JobQueue {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
  claim(): Promise<null> {
    return Promise.resolve(null);
  }
  heartbeat(job: never): Promise<never> {
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

async function runOperation(kind: 'plan' | 'build') {
  const conversations = new MemoryConversations();
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const workspaces = new FakeWorkspaces({ on: true });
  const executorA = new ControllableAgentExecutor({}, workspaces);
  const executorsA: ExecutorRegistry = { 
    get: () => executorA, 
    health: () => Promise.resolve([]) 
  };

  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = {
    get: () => new AgentExecutorFromExecutionPlane(executor),
    health: () => Promise.resolve([]),
  };
  const clock = new FixedClock();
  const ids = new SequentialIds();

  await conversations.createConversation({
    id: 'project-1',
    projectId: 'project-1',
    createdAt: clock.now().toISOString(),
  });
  const message = await conversations.appendMessage({
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle to settings' }],
    createdAt: clock.now().toISOString(),
  });

  const operationService = new OperationService(
    conversations,
    runs,
    new MemoryQueue(),
    artifacts,
    clock,
    ids,
  );
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
    clock,
    ids,
    { agentTimeoutMs: 60_000 },
  );

  const operation = await operationService.start(
    'project-1',
    message.id,
    kind === 'plan' ? { kind: 'plan' } : { kind: 'build', directExecution: true },
  );
  await runner.run('project-1', operation.runId!, operation.id);

  return { run: (await runs.get(operation.runId!))!, workspaces };
}

describe('Plan vs Build modes (#37)', () => {
  it('produces different workspace side effects for the identical message', async () => {
    const plan = await runOperation('plan');
    const build = await runOperation('build');

    expect(plan.run.status).toBe('completed');
    expect(build.run.status).toBe('completed');

    expect(plan.workspaces.checkpoints).toEqual([]);
    expect(plan.workspaces.commits).toEqual([]);

    expect(build.workspaces.checkpoints).toHaveLength(1);
    expect(build.workspaces.commits).toHaveLength(1);
  });
});
