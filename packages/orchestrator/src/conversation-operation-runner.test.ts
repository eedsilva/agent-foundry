import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  ExecutorRegistry,
  HarnessRepository,
  IdGenerator,
  MetricsRepository,
  ModelRouter,
  ProjectVersionRepository,
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import type {
  AgentExecutionRequest,
  ExecutorStreamEvent,
  ProjectVersion,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  AgentExecutorFromExecutionPlane,
  ControllableExecutor,
  FakeWorkspaces,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryRuns,
  InMemoryStepAttempts,
  InMemoryStepEvents,
  InMemoryStepRuns,
  MemoryConversations,
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

class MemoryProjectVersions implements ProjectVersionRepository {
  private readonly store: ProjectVersion[] = [];
  create(version: ProjectVersion): Promise<void> {
    this.store.push(version);
    return Promise.resolve();
  }
  get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    return Promise.resolve(
      this.store.find((v) => v.projectId === projectId && v.id === versionId) ?? null,
    );
  }
  list(projectId: string, limit = 50): Promise<ProjectVersion[]> {
    return Promise.resolve(
      this.store
        .filter((v) => v.projectId === projectId)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, limit),
    );
  }
  update(version: ProjectVersion, _expectedVersion: number): Promise<ProjectVersion> {
    const index = this.store.findIndex((v) => v.id === version.id);
    this.store[index] = version;
    return Promise.resolve(version);
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

function setup(harness: HarnessRepository = harnessRepo) {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const stepEvents = new InMemoryStepEvents();
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const projectVersions = new MemoryProjectVersions();
  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = {
    get: () => new AgentExecutorFromExecutionPlane(executor),
    health: () => Promise.resolve([]),
  };
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    stepEvents,
    harness,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    projectVersions,
    new FixedClock(),
    new SequentialIds(),
    { agentTimeoutMs: 60_000 },
  );
  return {
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    stepEvents,
    workspaces,
    conversations,
    projectVersions,
    runner,
  };
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
    const artifact = await artifacts.getLatest('project-1', `operation-${operationId}`);
    expect(artifact).not.toBeNull();
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([
      {
        name: artifact!.metadata.name,
        revision: artifact!.metadata.revision,
        sha256: artifact!.metadata.sha256,
      },
    ]);
  });

  it('completes a build operation and commits the touched workspace', async () => {
    const { runs, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    const artifact = await artifacts.getLatest('project-1', `operation-${operationId}`);
    expect(artifact).not.toBeNull();
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([
      {
        name: artifact!.metadata.name,
        revision: artifact!.metadata.revision,
        sha256: artifact!.metadata.sha256,
      },
    ]);
  });

  it('persists live executor stream events via StepEventRepository', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const projectVersions = new MemoryProjectVersions();
    // ControllableExecutor/AgentExecutorFromExecutionPlane predate onEvent and
    // don't forward it, so this test uses a minimal streaming stub instead.
    const executors: ExecutorRegistry = {
      get: () => ({
        provider: 'mock',
        execute: async (
          _request: AgentExecutionRequest,
          _signal: AbortSignal | undefined,
          onEvent?: (event: ExecutorStreamEvent) => void,
        ) => {
          onEvent?.({ type: 'status', phase: 'started' });
          return {
            runId: 'run-1',
            stepRunId: 'unused',
            attemptId: 'unused',
            provider: 'mock' as const,
            model: 'mock',
            exitCode: 0,
            durationMs: 1,
            stdout: '',
            stderr: '',
            output: {
              schemaVersion: '1' as const,
              status: 'completed' as const,
              summary: 'done',
              data: {},
              decisions: [],
              assumptions: [],
              risks: [],
              nextActions: [],
            },
          };
        },
        health: async () => ({ provider: 'mock', available: true, message: 'ok' }),
      }),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      projectVersions,
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    const streamEvents = await stepEvents.list(runId);
    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]).toMatchObject({ runId, type: 'status', phase: 'started' });
  });

  it('marks the run failed and rolls back the checkpoint when the executor fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
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

  it('clears an artifactReferences inherited from the plan when a build-from-plan run fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );

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
      workflowId: 'conversation-build',
      status: 'queued',
      version: 1,
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
    });
    // Simulates OperationService.start() copying the approved plan's own
    // artifactReferences onto a new build operation, before this run ever
    // executes — the exact inherited-reference scenario a failed run must
    // not leave behind.
    await conversations.createOperation({
      id: operationId,
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'build',
      idempotencyKey: 'a'.repeat(64),
      runId,
      artifactReferences: [{ name: 'operation-plan-1', revision: 1, sha256: 'b'.repeat(64) }],
      planOperationId: 'plan-1',
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    await runner.run('project-1', runId, operationId);

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('failed');
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([]);
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
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor({}, workspaces);
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
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

  it('resolves run() when the workflow run completion update fails after the step succeeded', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    (runs as InMemoryRuns).onBeforeUpdate = (run) => {
      if (run.status === 'completed') {
        throw new Error('run store unavailable');
      }
    };
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor({}, workspaces);
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    // The step attempt and stepRun already reached their terminal 'completed'
    // state before the WorkflowRun's own completion write failed. The catch
    // block must not blindly re-transition the already-terminal stepRun to
    // 'failed' (that throws InvalidStateTransitionError and would make run()
    // reject), and run() must still resolve.
    await expect(runner.run('project-1', runId, operationId)).resolves.toBeUndefined();

    const stepRunList = await stepRuns.list(runId);
    expect(stepRunList[0]?.status).toBe('completed');
  });

  it('resolves run() and still marks stepRun/run failed when the checkpoint rollback throws', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    workspaces.rollback = () => Promise.reject(new Error('rollback unavailable'));
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    // run() must resolve even though workspaces.rollback itself throws (e.g. a
    // git I/O error), and the failed-state transitions below the rollback call
    // must still execute so the run isn't stranded in 'running' forever.
    await expect(runner.run('project-1', runId, operationId)).resolves.toBeUndefined();

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('failed');
    const stepRunList = await stepRuns.list(runId);
    expect(stepRunList[0]?.status).toBe('failed');
  });

  it('resolves run() when appending the operation.failed event also throws', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true });
    events.onBeforeAppend = () => {
      throw new Error('event store unavailable');
    };
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    // run() must resolve even though the catch block's own operation.failed
    // event append throws; the durable stepRun/run failed state was already
    // recorded before this best-effort append ran.
    await expect(runner.run('project-1', runId, operationId)).resolves.toBeUndefined();

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('failed');
  });
});

describe('ConversationOperationRunner context compilation', () => {
  it('embeds the compiled context digest in the compiled instructions and records sources on the change request', async () => {
    const fragmentHarness: HarnessRepository = {
      select: () =>
        Promise.resolve({
          version: 'v1',
          files: [{ path: 'CLAUDE.md', content: 'Be terse.', priority: 1 }],
          combined: 'Be terse.',
        }),
      version: () => Promise.resolve('v1'),
    };
    const { runs, workspaces, conversations, runner } = setup(fragmentHarness);
    await conversations.createConversation({
      id: 'project-1',
      projectId: 'project-1',
      createdAt: '2026-07-18T11:00:00.000Z',
    });
    await conversations.appendMessage({
      id: 'message-earlier',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T11:00:00.000Z',
    });
    const confirmedDecision = await conversations.createChangeRequest({
      id: 'cr-earlier',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-earlier',
      suggestedKind: 'build',
      confirmedKind: 'build',
      summary: 'Add a login page with email and password.',
      rationale: 'Imperative verb.',
      referencedDecisionIds: [],
      contextSources: [],
      status: 'confirmed',
      createdAt: '2026-07-18T11:00:00.000Z',
      decidedAt: '2026-07-18T11:00:01.000Z',
    });
    await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Change the login page to use magic links.' }],
      createdAt: '2026-07-18T12:00:00.000Z',
    });
    const changeRequest = await conversations.createChangeRequest({
      id: 'cr-current',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      suggestedKind: 'build',
      summary: 'Change the login page to use magic links.',
      rationale: 'Imperative verb.',
      referencedDecisionIds: [confirmedDecision.id],
      contextSources: [],
      status: 'proposed',
      createdAt: '2026-07-18T12:00:00.000Z',
    });
    const runId = 'run-1';
    const operationId = 'operation-1';
    await runs.create({
      id: runId,
      projectId: 'project-1',
      workflowId: 'conversation-build',
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
      kind: 'build',
      idempotencyKey: 'a'.repeat(64),
      runId,
      changeRequestId: changeRequest.id,
      directExecution: true,
      artifactReferences: [],
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    await runner.run('project-1', runId, operationId);

    expect(workspaces.lastRequestMarkdown).toContain('Pinned decisions');
    expect(workspaces.lastRequestMarkdown).toContain(confirmedDecision.id);

    const updatedChangeRequest = await conversations.getChangeRequest(
      'project-1',
      changeRequest.id,
    );
    const sourceIds = updatedChangeRequest?.contextSources.map((s) => s.id) ?? [];
    expect(sourceIds).toContain(confirmedDecision.id);
    expect(sourceIds).toContain('CLAUDE.md');
  });

  it('runs unaffected when the operation has no changeRequestId (existing manual-toggle path)', async () => {
    const { runs, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
  });
});

describe('ConversationOperationRunner foundry.operation span', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('wraps a successful run in a foundry.operation span', async () => {
    const { runs, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    const span = exporter.getFinishedSpans().find((item) => item.name === 'foundry.operation');
    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject({
      'foundry.operation.id': operationId,
      'foundry.operation.kind': 'build',
    });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the span ERROR with force_sample when the run fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const stepEvents = new InMemoryStepEvents();
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = {
      get: () => new AgentExecutorFromExecutionPlane(executor),
      health: () => Promise.resolve([]),
    };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      stepEvents,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new MemoryProjectVersions(),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    const span = exporter.getFinishedSpans().find((item) => item.name === 'foundry.operation');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['foundry.force_sample']).toBe(true);
  });
});
