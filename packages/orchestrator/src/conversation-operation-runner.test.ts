import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  WorkspaceManager,
  VerificationService,
} from '@agent-foundry/domain';
import type {
  AgentExecutionRequest,
  BrowserVerificationReport,
  ExecutorStreamEvent,
  ProjectVersion,
  VisualEdit,
  VerificationReport,
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
import type { BrowserVerificationCoordinator } from './browser-verification-coordinator.js';
import { ProjectVersionService } from './project-version-service.js';

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
  onBeforeCreate?: (version: ProjectVersion) => void;
  onBeforeDiscard?: (version: ProjectVersion) => void | Promise<void>;
  create(version: ProjectVersion): Promise<void> {
    this.onBeforeCreate?.(version);
    this.store.push(version);
    return Promise.resolve();
  }
  async discardUnpromoted(version: ProjectVersion): Promise<void> {
    await this.onBeforeDiscard?.(version);
    const index = this.store.findIndex(
      (entry) => entry.projectId === version.projectId && entry.id === version.id,
    );
    if (index < 0) return;
    const existing = this.store[index]!;
    if (existing.protected || JSON.stringify(existing) !== JSON.stringify(version)) {
      throw Object.assign(
        new Error(
          `Project version ${version.id} no longer matches the unpromoted version and cannot be discarded`,
        ),
        { code: 'PROJECT_VERSION_DISCARD_REFUSED' },
      );
    }
    this.store.splice(index, 1);
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

function newProjectVersionService(
  workspaces: WorkspaceManager,
  artifacts: ArtifactStore,
): ProjectVersionService {
  return new ProjectVersionService(
    new MemoryProjectVersions(),
    workspaces,
    artifacts,
    new FixedClock(),
    new SequentialIds(),
  );
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

function setup(
  harness: HarnessRepository = harnessRepo,
  direct?: {
    verifier: VerificationService;
    browserVerification: Pick<BrowserVerificationCoordinator, 'verify'>;
  },
) {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const stepEvents = new InMemoryStepEvents();
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const projectVersions = new MemoryProjectVersions();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const projectVersionService = new ProjectVersionService(
    projectVersions,
    workspaces,
    artifacts,
    clock,
    ids,
  );
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
    projectVersionService,
    clock,
    ids,
    { agentTimeoutMs: 60_000, ...direct },
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

const directVisualEdit = {
  target: { domPath: 'main > h1', file: 'src/App.tsx', line: 12, column: 5 },
  property: 'text' as const,
  oldValue: 'Old title',
  newValue: 'New title',
};

function approvedDirectServices(): {
  verifier: VerificationService;
  browserVerification: Pick<BrowserVerificationCoordinator, 'verify'>;
} {
  return {
    verifier: {
      verify: () =>
        Promise.resolve({
          schemaVersion: '1',
          approved: true,
          packageManager: 'npm',
          summary: 'approved',
          commands: [],
          createdAt: '2026-07-18T12:00:00.000Z',
        }),
    },
    browserVerification: {
      verify: (input) =>
        Promise.resolve({
          schemaVersion: '1',
          approved: true,
          summary: 'browser approved',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-visual',
            status: 'running',
            evidence: { screenshots: [] },
          },
          steps: [],
        }),
    },
  };
}

async function seedVisualEdit(
  conversations: MemoryConversations,
  runs: WorkflowRunRepository,
  visualEdit: VisualEdit | null = directVisualEdit,
): Promise<{ runId: string; operationId: string }> {
  await conversations.createConversation({
    id: 'project-1',
    projectId: 'project-1',
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  await conversations.appendMessage({
    id: 'message-visual',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Make the hero title clearer.' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  const runId = 'run-visual';
  const operationId = 'operation-visual';
  await runs.create({
    id: runId,
    projectId: 'project-1',
    workflowId: 'conversation-visual-edit',
    status: 'queued',
    version: 1,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:00.000Z',
  });
  await conversations.createOperation({
    id: operationId,
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-visual',
    kind: 'visual-edit',
    idempotencyKey: 'e'.repeat(64),
    runId,
    artifactReferences: [],
    ...(visualEdit ? { visualEdit } : {}),
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  return { runId, operationId };
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
  it('rejects a workflow run owned by another project before creating execution state', async () => {
    const { runs, stepRuns, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seedVisualEdit(conversations, runs);
    const run = (await runs.get(runId))!;
    await runs.update({ ...run, projectId: 'project-2' }, run.version);

    await expect(runner.run('project-1', runId, operationId)).rejects.toThrow(
      'does not belong to project project-1',
    );

    expect(await stepRuns.list(runId)).toEqual([]);
    expect(await artifacts.listLatest('project-1')).toEqual([]);
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.dirty).toBe(false);
  });

  it('rejects an operation bound to another run before creating execution state', async () => {
    const { runs, stepRuns, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seedVisualEdit(conversations, runs);
    const operation = (await conversations.getOperation('project-1', operationId))!;
    await conversations.updateOperation({ ...operation, runId: 'run-other' });

    await expect(runner.run('project-1', runId, operationId)).rejects.toThrow(
      'is not bound to workflow run run-visual',
    );

    expect(await stepRuns.list(runId)).toEqual([]);
    expect(await artifacts.listLatest('project-1')).toEqual([]);
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.dirty).toBe(false);
  });

  it('runs a free-form visual request as a non-mutating clarification step', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup();
    const { runId, operationId } = await seedVisualEdit(conversations, runs, null);

    await runner.run('project-1', runId, operationId);

    const run = await runs.get(runId);
    expect(run?.error).toBeUndefined();
    expect(run?.status).toBe('completed');
    expect(workspaces.lastRequestMarkdown).toContain('Clarify');
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.commits).toEqual([]);
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it('runs the exact direct patch through deterministic and browser gates before its only commit/version', async () => {
    const order: string[] = [];
    const verifier: VerificationService = {
      verify: vi.fn((input): Promise<VerificationReport> => {
        order.push('deterministic');
        expect(input).toMatchObject({
          scripts: ['typecheck', 'lint', 'test', 'build'],
          includeGitDiffCheck: true,
        });
        return Promise.resolve({
          schemaVersion: '1',
          approved: true,
          packageManager: 'npm',
          summary: 'approved',
          commands: [],
          createdAt: '2026-07-18T12:00:00.000Z',
        });
      }),
    };
    const browserVerification: Pick<BrowserVerificationCoordinator, 'verify'> = {
      verify: vi.fn((input): Promise<BrowserVerificationReport> => {
        order.push('browser');
        expect(input.runId).toBe('run-visual');
        expect(input.plan.metadata.runId).toBe('run-visual');
        expect((input.plan.content as { data: { steps: unknown[] } }).data.steps).toHaveLength(1);
        expect(input.plan.content).toMatchObject({
          data: {
            steps: [
              {
                assertions: [
                  expect.objectContaining({ kind: 'containsText', expected: 'New title' }),
                ],
              },
            ],
          },
        });
        return Promise.resolve({
          schemaVersion: '1',
          approved: true,
          summary: 'browser approved',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-visual',
            status: 'running',
            evidence: {
              screenshots: [
                {
                  name: 'browser-screenshot-preview-visual-verify-visual-edit',
                  revision: 1,
                  sha256: 'f'.repeat(64),
                  stepId: 'verify-visual-edit',
                  url: 'http://127.0.0.1/',
                  viewport: { width: 1280, height: 800 },
                },
              ],
            },
          },
          steps: [
            {
              stepId: 'verify-visual-edit',
              title: 'Verify visual edit',
              status: 'passed',
              durationMs: 1,
              observations: [],
            },
          ],
        });
      }),
    };
    const { runs, artifacts, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      { verifier, browserVerification },
    );
    workspaces.onBeforeCommit = () => order.push('commit');
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    await runner.run('project-1', runId, operationId);

    expect(workspaces.lastRequestMarkdown).toContain(JSON.stringify(directVisualEdit, null, 2));
    expect(workspaces.lastRequestMarkdown).toContain('Tailwind');
    expect(order).toEqual(['deterministic', 'browser', 'commit']);
    expect(workspaces.commits).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toHaveLength(1);
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences.map((reference) => reference.name)).toEqual([
      `operation-${operationId}`,
      `visual-edit-verification-${operationId}`,
      `visual-edit-browser-plan-${operationId}`,
      `visual-edit-browser-report-${operationId}`,
      'browser-screenshot-preview-visual-verify-visual-edit',
    ]);
    expect(
      await artifacts.getLatest('project-1', `visual-edit-browser-report-${operationId}`),
    ).not.toBeNull();
  });

  it('rolls back and leaves the operation unpromoted when version recording fails', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      approvedDirectServices(),
    );
    projectVersions.onBeforeCreate = () => {
      throw new Error('version store unavailable');
    };
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('failed');
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toEqual([]);
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([]);
    expect(operation?.projectVersionId).toBeUndefined();
  });

  it('discards the recorded version and rolls back when operation promotion fails', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      approvedDirectServices(),
    );
    const updateOperation = conversations.updateOperation.bind(conversations);
    conversations.updateOperation = vi.fn((operation) => {
      if (operation.projectVersionId) {
        return Promise.reject(new Error('operation store unavailable'));
      }
      return updateOperation(operation);
    });
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('failed');
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toEqual([]);
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([]);
    expect(operation?.projectVersionId).toBeUndefined();
  });

  it('surfaces provisional-version discard infrastructure failure with the promotion error', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      approvedDirectServices(),
    );
    projectVersions.onBeforeDiscard = () => {
      throw new Error('version delete unavailable');
    };
    const updateOperation = conversations.updateOperation.bind(conversations);
    conversations.updateOperation = vi.fn((operation) =>
      operation.projectVersionId
        ? Promise.reject(new Error('operation store unavailable'))
        : updateOperation(operation),
    );
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    const failure = await runner.run('project-1', runId, operationId).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('operation store unavailable');
    expect((failure as Error).message).toContain(
      'provisional version discard failed: version delete unavailable',
    );
    expect((await runs.get(runId))?.error?.message).toBe((failure as Error).message);
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toHaveLength(1);
  });

  it('surfaces a protected-version discard refusal and preserves that version', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      approvedDirectServices(),
    );
    projectVersions.onBeforeDiscard = async (version) => {
      await projectVersions.update({ ...version, protected: true }, version.version);
    };
    const updateOperation = conversations.updateOperation.bind(conversations);
    conversations.updateOperation = vi.fn((operation) =>
      operation.projectVersionId
        ? Promise.reject(new Error('operation store unavailable'))
        : updateOperation(operation),
    );
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    const failure = await runner.run('project-1', runId, operationId).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      'provisional version discard refused: Project version',
    );
    expect((await runs.get(runId))?.error?.message).toBe((failure as Error).message);
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toEqual([
      expect.objectContaining({ protected: true }),
    ]);
  });

  it('surfaces operation restoration failure after a later terminal write fails', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup(
      harnessRepo,
      approvedDirectServices(),
    );
    (runs as InMemoryRuns).onBeforeUpdate = (run) => {
      if (run.status === 'completed') throw new Error('run store unavailable');
    };
    const updateOperation = conversations.updateOperation.bind(conversations);
    conversations.updateOperation = vi.fn((operation) =>
      operation.projectVersionId
        ? updateOperation(operation)
        : Promise.reject(new Error('operation restore unavailable')),
    );
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    const failure = await runner.run('project-1', runId, operationId).catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('run store unavailable');
    expect((failure as Error).message).toContain(
      'operation restore failed: operation restore unavailable',
    );
    expect((failure as Error).message).toContain(
      'provisional version discard skipped: operation restore failed; version retained',
    );
    expect((await runs.get(runId))?.error?.message).toBe((failure as Error).message);
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(await projectVersions.list('project-1')).toHaveLength(1);
  });

  it('rejects a dirty direct-edit baseline before checkpointing or creating a version', async () => {
    const { runs, workspaces, conversations, projectVersions, runner } = setup();
    workspaces.dirty = true;
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('failed');
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.commits).toEqual([]);
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it('rejects an empty direct-edit source diff before running verification', async () => {
    const verify = vi.fn(() => Promise.reject(new Error('verification must not run')));
    const { runs, workspaces, conversations, projectVersions, runner } = setup(harnessRepo, {
      verifier: { verify },
      browserVerification: { verify: () => Promise.reject(new Error('browser must not run')) },
    });
    workspaces.isClean = () => Promise.resolve(true);
    const { runId, operationId } = await seedVisualEdit(conversations, runs);

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('failed');
    expect(verify).not.toHaveBeenCalled();
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(workspaces.commits).toEqual([]);
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it('rejects a style edit whose browser gate returns no screenshot evidence', async () => {
    const verifier: VerificationService = {
      verify: () =>
        Promise.resolve({
          schemaVersion: '1',
          approved: true,
          packageManager: 'npm',
          summary: 'approved',
          commands: [],
          createdAt: '2026-07-18T12:00:00.000Z',
        }),
    };
    const browserVerification: Pick<BrowserVerificationCoordinator, 'verify'> = {
      verify: (input) =>
        Promise.resolve({
          schemaVersion: '1',
          approved: true,
          summary: 'browser approved without screenshots',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-visual',
            status: 'running',
            evidence: { screenshots: [] },
          },
          steps: [],
        }),
    };
    const { runs, workspaces, conversations, projectVersions, runner } = setup(harnessRepo, {
      verifier,
      browserVerification,
    });
    const { runId, operationId } = await seedVisualEdit(conversations, runs, {
      ...directVisualEdit,
      property: 'color',
      oldValue: '#000000',
      newValue: '#ffffff',
    });

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('failed');
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(workspaces.commits).toEqual([]);
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it.each(['deterministic', 'browser'] as const)(
    'rolls back and creates no version when the %s gate rejects the direct edit',
    async (failedGate) => {
      const verifier: VerificationService = {
        verify: () =>
          Promise.resolve({
            schemaVersion: '1',
            approved: failedGate !== 'deterministic',
            packageManager: 'npm',
            summary: `${failedGate} result`,
            commands: [],
            createdAt: '2026-07-18T12:00:00.000Z',
          }),
      };
      const browserVerification: Pick<BrowserVerificationCoordinator, 'verify'> = {
        verify: (input) =>
          Promise.resolve({
            schemaVersion: '1',
            approved: failedGate !== 'browser',
            summary: `${failedGate} result`,
            planArtifact: {
              name: input.plan.metadata.name,
              revision: input.plan.metadata.revision,
              sha256: input.plan.metadata.sha256,
            },
            previewSession: {
              sessionId: 'preview-visual',
              status: 'running',
              evidence: { screenshots: [] },
            },
            steps: [],
          }),
      };
      const { runs, workspaces, conversations, projectVersions, runner } = setup(harnessRepo, {
        verifier,
        browserVerification,
      });
      const { runId, operationId } = await seedVisualEdit(conversations, runs);

      await runner.run('project-1', runId, operationId);

      expect((await runs.get(runId))?.status).toBe('failed');
      expect(workspaces.rollbacks).toHaveLength(1);
      expect(workspaces.commits).toEqual([]);
      expect(await projectVersions.list('project-1')).toEqual([]);
    },
  );

  it('completes a plan operation without touching the workspace or recording a version', async () => {
    const { runs, artifacts, workspaces, conversations, projectVersions, runner } = setup();
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
    expect(operation?.projectVersionId).toBeUndefined();
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it('completes a build operation, commits the touched workspace, and records exactly one ProjectVersion', async () => {
    const { runs, artifacts, workspaces, conversations, projectVersions, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    const artifact = await artifacts.getLatest('project-1', `operation-${operationId}`);
    expect(artifact).not.toBeNull();

    const versions = await projectVersions.list('project-1');
    expect(versions).toHaveLength(1);
    const [version] = versions;
    expect(version).toMatchObject({
      projectId: 'project-1',
      runId,
      kind: 'run',
      commit: workspaces.commits[0],
    });

    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([
      {
        name: artifact!.metadata.name,
        revision: artifact!.metadata.revision,
        sha256: artifact!.metadata.sha256,
      },
    ]);
    expect(operation?.projectVersionId).toBe(version!.id);
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
    const projectVersions = newProjectVersionService(workspaces, artifacts);
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
      newProjectVersionService(workspaces, artifacts),
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
      newProjectVersionService(workspaces, artifacts),
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
      newProjectVersionService(workspaces, artifacts),
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
      newProjectVersionService(workspaces, artifacts),
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

  it('surfaces rollback failure and records it with the original run error', async () => {
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
      newProjectVersionService(workspaces, artifacts),
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    const failure = await runner.run('project-1', runId, operationId).catch((error) => error);

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('boom');
    expect((failure as Error).message).toContain('workspace rollback failed: rollback unavailable');
    expect(run.status).toBe('failed');
    expect(run.error?.message).toBe((failure as Error).message);
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
      newProjectVersionService(workspaces, artifacts),
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
