import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ModelDefinitionSchema,
  RouteDecisionSchema,
  WorkflowDefinitionSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ArtifactMetadata,
  type ExecutorHealth,
  type ModelDefinition,
  type Project,
  type ProjectEvent,
  type StepAttempt,
  type StepRun,
  type StoredArtifact,
  type VerificationReport,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import {
  ResumeBlockedError,
  SystemClock,
  VersionConflictError,
  type AgentExecutor,
  type ArtifactStore,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type ProjectRepository,
  type StepAttemptRepository,
  type StepRunRepository,
  type VerificationService,
  type WorkflowRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { ProjectService } from './project-service.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

const WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'run-controls-v1',
  name: 'Run controls fixture',
  description: 'Plan, implement, review and verify nodes for pause/retry/idempotency tests.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan the work.',
      outputArtifact: 'plan',
    },
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the plan.',
      inputArtifacts: ['plan'],
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
      maxAttempts: 1,
    },
    {
      id: 'review',
      type: 'agent',
      role: 'code-reviewer',
      taskKind: 'code-review',
      title: 'Review',
      instructions: 'Review the implementation.',
      inputArtifacts: ['implementation'],
      outputArtifact: 'review',
    },
    {
      id: 'verify',
      type: 'verify',
      title: 'Verify',
      outputArtifact: 'verification-report',
    },
  ],
});

const MODELS: ModelDefinition[] = [
  ModelDefinitionSchema.parse({
    id: 'model-1',
    provider: 'codex',
    model: 'test-model',
    maxContextTokens: 200_000,
    capabilities: {
      planning: 0.5,
      architecture: 0.5,
      coding: 0.5,
      review: 0.5,
      repair: 0.5,
      structuredOutput: 0.5,
      speed: 0.5,
      costEfficiency: 0.5,
      reliability: 0.5,
    },
  }),
  ModelDefinitionSchema.parse({
    id: 'model-2',
    provider: 'codex',
    model: 'alt-model',
    maxContextTokens: 200_000,
    capabilities: {
      planning: 0.5,
      architecture: 0.5,
      coding: 0.5,
      review: 0.5,
      repair: 0.5,
      structuredOutput: 0.5,
      speed: 0.5,
      costEfficiency: 0.5,
      reliability: 0.5,
    },
  }),
];

interface PowerSwitch {
  on: boolean;
}

function checkPower(power: PowerSwitch): void {
  if (!power.on) throw new Error('simulated power loss');
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class InMemoryProjects implements ProjectRepository {
  private readonly store = new Map<string, Project>();
  constructor(private readonly power: PowerSwitch) {}
  create(project: Project): Promise<void> {
    checkPower(this.power);
    this.store.set(project.id, { ...project });
    return Promise.resolve();
  }
  get(projectId: string): Promise<Project | null> {
    const project = this.store.get(projectId);
    return Promise.resolve(project ? { ...project } : null);
  }
  update(project: Project, expectedVersion: number): Promise<Project> {
    checkPower(this.power);
    const existing = this.store.get(project.id);
    if (!existing) throw new Error(`project ${project.id} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError('project', project.id, expectedVersion, existing.version);
    }
    const updated = { ...project, version: expectedVersion + 1 };
    this.store.set(project.id, updated);
    return Promise.resolve({ ...updated });
  }
  list(): Promise<Project[]> {
    return Promise.resolve([...this.store.values()]);
  }
}

class InMemoryRuns implements WorkflowRunRepository {
  private readonly store = new Map<string, WorkflowRun>();
  constructor(private readonly power: PowerSwitch) {}
  create(run: WorkflowRun): Promise<void> {
    checkPower(this.power);
    this.store.set(run.id, { ...run });
    return Promise.resolve();
  }
  get(runId: string): Promise<WorkflowRun | null> {
    const run = this.store.get(runId);
    return Promise.resolve(run ? { ...run } : null);
  }
  list(projectId: string): Promise<WorkflowRun[]> {
    return Promise.resolve([...this.store.values()].filter((run) => run.projectId === projectId));
  }
  update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun> {
    checkPower(this.power);
    const existing = this.store.get(run.id);
    if (!existing) throw new Error(`run ${run.id} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError('workflow-run', run.id, expectedVersion, existing.version);
    }
    const updated = { ...run, version: expectedVersion + 1 };
    this.store.set(run.id, updated);
    return Promise.resolve({ ...updated });
  }
}

class InMemoryStepRuns implements StepRunRepository {
  readonly store = new Map<string, StepRun>();
  constructor(private readonly power: PowerSwitch) {}
  create(step: StepRun): Promise<void> {
    checkPower(this.power);
    this.store.set(`${step.runId}/${step.id}`, { ...step });
    return Promise.resolve();
  }
  get(runId: string, stepRunId: string): Promise<StepRun | null> {
    const step = this.store.get(`${runId}/${stepRunId}`);
    return Promise.resolve(step ? { ...step } : null);
  }
  list(runId: string): Promise<StepRun[]> {
    return Promise.resolve(
      [...this.store.values()]
        .filter((step) => step.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }
  update(step: StepRun, expectedVersion: number): Promise<StepRun> {
    checkPower(this.power);
    const key = `${step.runId}/${step.id}`;
    const existing = this.store.get(key);
    if (!existing) throw new Error(`step ${key} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError('step-run', step.id, expectedVersion, existing.version);
    }
    const updated = { ...step, version: expectedVersion + 1 };
    this.store.set(key, updated);
    return Promise.resolve({ ...updated });
  }
  byStepId(runId: string, stepId: string): StepRun[] {
    return [...this.store.values()]
      .filter((step) => step.runId === runId && step.stepId === stepId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

class InMemoryStepAttempts implements StepAttemptRepository {
  readonly store = new Map<string, StepAttempt>();
  constructor(private readonly power: PowerSwitch) {}
  create(attempt: StepAttempt): Promise<void> {
    checkPower(this.power);
    this.store.set(`${attempt.runId}/${attempt.stepRunId}/${attempt.id}`, { ...attempt });
    return Promise.resolve();
  }
  get(runId: string, stepRunId: string, attemptId: string): Promise<StepAttempt | null> {
    const attempt = this.store.get(`${runId}/${stepRunId}/${attemptId}`);
    return Promise.resolve(attempt ? { ...attempt } : null);
  }
  list(runId: string, stepRunId: string): Promise<StepAttempt[]> {
    return Promise.resolve(
      [...this.store.values()].filter(
        (attempt) => attempt.runId === runId && attempt.stepRunId === stepRunId,
      ),
    );
  }
  update(attempt: StepAttempt, expectedVersion: number): Promise<StepAttempt> {
    checkPower(this.power);
    const key = `${attempt.runId}/${attempt.stepRunId}/${attempt.id}`;
    const existing = this.store.get(key);
    if (!existing) throw new Error(`attempt ${key} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError('step-attempt', attempt.id, expectedVersion, existing.version);
    }
    const updated = { ...attempt, version: expectedVersion + 1 };
    this.store.set(key, updated);
    return Promise.resolve({ ...updated });
  }
  all(): StepAttempt[] {
    return [...this.store.values()];
  }
}

class InMemoryArtifacts implements ArtifactStore {
  readonly artifacts: StoredArtifact[] = [];
  onAfterPut?: ((name: string) => void) | undefined;
  constructor(private readonly power: PowerSwitch) {}
  put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
    idempotencyKey?: string;
  }): Promise<StoredArtifact> {
    checkPower(this.power);
    const revision = this.named(input.name).length + 1;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision,
      contentType: input.contentType ?? 'application/json',
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      sha256: createHash('sha256').update(JSON.stringify(input.content)).digest('hex'),
    };
    const stored: StoredArtifact = { metadata, content: input.content };
    this.artifacts.push(stored);
    this.onAfterPut?.(input.name);
    return Promise.resolve(stored);
  }
  getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    const matches = this.artifacts.filter(
      (artifact) => artifact.metadata.projectId === projectId && artifact.metadata.name === name,
    );
    return Promise.resolve(matches.at(-1) ?? null);
  }
  getRevision(projectId: string, name: string, revision: number): Promise<StoredArtifact | null> {
    return Promise.resolve(
      this.artifacts.find(
        (artifact) =>
          artifact.metadata.projectId === projectId &&
          artifact.metadata.name === name &&
          artifact.metadata.revision === revision,
      ) ?? null,
    );
  }
  listLatest(): Promise<StoredArtifact[]> {
    return Promise.resolve([...this.artifacts]);
  }
  listMetadata(_projectId?: string, name?: string): Promise<ArtifactMetadata[]> {
    const items = name ? this.named(name) : this.artifacts;
    return Promise.resolve(items.map((artifact) => artifact.metadata));
  }
  named(name: string): StoredArtifact[] {
    return this.artifacts.filter((artifact) => artifact.metadata.name === name);
  }
}

class InMemoryEvents implements EventStore {
  readonly events: ProjectEvent[] = [];
  constructor(private readonly power: PowerSwitch) {}
  append(event: ProjectEvent): Promise<void> {
    checkPower(this.power);
    if (event.dedupeKey && this.events.some((item) => item.dedupeKey === event.dedupeKey)) {
      return Promise.resolve();
    }
    this.events.push(event);
    return Promise.resolve();
  }
  list(projectId: string): Promise<ProjectEvent[]> {
    return Promise.resolve(this.events.filter((event) => event.projectId === projectId));
  }
  types(): string[] {
    return this.events.map((event) => event.type);
  }
}

/** Mimics git: commits only when the executor touched the workspace. */
class FakeWorkspaces implements WorkspaceManager {
  readonly checkpoints: string[] = [];
  readonly commits: string[] = [];
  readonly rollbacks: string[] = [];
  current = 'initial-head';
  dirty = false;
  onAfterCommit?: (() => void) | undefined;
  private counter = 0;
  constructor(private readonly power: PowerSwitch) {}
  projectRoot(projectId: string): string {
    return `/fake/${projectId}`;
  }
  workspacePath(projectId: string): string {
    return `/fake/${projectId}/workspace`;
  }
  ensure(): Promise<void> {
    return Promise.resolve();
  }
  writePrd(): Promise<void> {
    return Promise.resolve();
  }
  writeRunContext(): Promise<{ requestPath: string; schemaPath: string }> {
    checkPower(this.power);
    return Promise.resolve({ requestPath: 'request.md', schemaPath: 'schema.json' });
  }
  ensureGit(): Promise<void> {
    return Promise.resolve();
  }
  checkpoint(): Promise<string> {
    checkPower(this.power);
    if (this.dirty) {
      this.current = this.nextSha();
      this.dirty = false;
    }
    this.checkpoints.push(this.current);
    return Promise.resolve(this.current);
  }
  rollback(_projectId: string, ref: string): Promise<void> {
    checkPower(this.power);
    this.rollbacks.push(ref);
    this.current = ref;
    this.dirty = false;
    return Promise.resolve();
  }
  commit(): Promise<string | null> {
    checkPower(this.power);
    if (!this.dirty) return Promise.resolve(null);
    this.current = this.nextSha();
    this.dirty = false;
    this.commits.push(this.current);
    this.onAfterCommit?.();
    return Promise.resolve(this.current);
  }
  head(): Promise<string | null> {
    return Promise.resolve(this.current);
  }
  touch(): void {
    this.dirty = true;
  }
  private nextSha(): string {
    this.counter += 1;
    return `sha-${String(this.counter).padStart(4, '0')}`;
  }
}

type ExecutorBehavior = 'instant' | 'gated';

class ControllableExecutor implements AgentExecutor {
  readonly provider = 'codex';
  readonly startCounts = new Map<string, number>();
  private readonly gates = new Map<string, () => void>();
  constructor(
    private readonly behaviors: Record<string, ExecutorBehavior>,
    private readonly workspaces: FakeWorkspaces,
  ) {}

  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.startCounts.set(request.stepId, (this.startCounts.get(request.stepId) ?? 0) + 1);
    const finish = (): AgentExecutionResult => {
      if (request.mutatesWorkspace) this.workspaces.touch();
      return this.result(request);
    };
    if ((this.behaviors[request.stepId] ?? 'instant') === 'instant') {
      return Promise.resolve(finish());
    }
    return new Promise((resolve) => {
      this.gates.set(request.stepId, () => resolve(finish()));
    });
  }

  release(stepId: string): void {
    const open = this.gates.get(stepId);
    if (!open) throw new Error(`no gated execution for ${stepId}`);
    this.gates.delete(stepId);
    open();
  }

  started(stepId: string): number {
    return this.startCounts.get(stepId) ?? 0;
  }

  health(): Promise<ExecutorHealth> {
    return Promise.resolve({ provider: 'codex', available: true, message: 'ok' });
  }

  private result(request: AgentExecutionRequest): AgentExecutionResult {
    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'codex',
      model: request.model,
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      output: {
        schemaVersion: '1',
        status: 'completed',
        summary: `${request.stepId} done.`,
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
    };
  }
}

interface Stores {
  power: PowerSwitch;
  clock: SystemClock;
  projects: InMemoryProjects;
  runs: InMemoryRuns;
  stepRuns: InMemoryStepRuns;
  stepAttempts: InMemoryStepAttempts;
  artifacts: InMemoryArtifacts;
  events: InMemoryEvents;
  workspaces: FakeWorkspaces;
  harnessVersion: { value: string };
}

function makeStores(): Stores {
  const power: PowerSwitch = { on: true };
  return {
    power,
    clock: new SystemClock(),
    projects: new InMemoryProjects(power),
    runs: new InMemoryRuns(power),
    stepRuns: new InMemoryStepRuns(power),
    stepAttempts: new InMemoryStepAttempts(power),
    artifacts: new InMemoryArtifacts(power),
    events: new InMemoryEvents(power),
    workspaces: new FakeWorkspaces(power),
    harnessVersion: { value: 'harness-1' },
  };
}

function makeHarness(behaviors: Record<string, ExecutorBehavior> = {}, existing?: Stores) {
  const stores = existing ?? makeStores();
  const ids = new SequentialIds();
  const executor = new ControllableExecutor(behaviors, stores.workspaces);
  const verifier: VerificationService = {
    verify: () =>
      Promise.resolve({
        schemaVersion: '1',
        approved: true,
        packageManager: 'npm',
        summary: 'ok',
        commands: [],
        createdAt: new Date().toISOString(),
      } satisfies VerificationReport),
  };
  const workflows: WorkflowRepository = {
    get: () => Promise.resolve(WORKFLOW),
    list: () => Promise.resolve([WORKFLOW]),
  };
  const harness: HarnessRepository = {
    select: () =>
      Promise.resolve({ version: stores.harnessVersion.value, files: [], combined: '' }),
    version: () => Promise.resolve(stores.harnessVersion.value),
  };
  const router: ModelRouter = {
    route: (profile) =>
      Promise.resolve(
        RouteDecisionSchema.parse({
          routeId: 'route-1',
          createdAt: new Date().toISOString(),
          profile,
          selected: {
            model: MODELS[0],
            score: {
              capability: 0.5,
              context: 0.5,
              speed: 0.5,
              cost: 0.5,
              reliability: 0.5,
              historical: 0.5,
              tagAffinity: 0,
              estimatedCostUsd: null,
              total: 3,
            },
          },
          fallbacks: [],
          rejected: [],
        }),
      ),
    catalog: () => Promise.resolve(MODELS),
  };
  const metrics: MetricsRepository = {
    get: () => Promise.resolve(null),
    record: vi.fn(() => Promise.resolve()),
    recordQuality: vi.fn(() => Promise.resolve()),
  };
  const registry: ExecutorRegistry = {
    get: () => executor,
    health: () => Promise.resolve([]),
  };
  const enqueued: unknown[] = [];
  const queue: JobQueue = {
    enqueue: (job) => {
      enqueued.push(job);
      return Promise.resolve();
    },
    claim: () => Promise.resolve(null),
    heartbeat: (job) => Promise.resolve(job),
    ack: () => Promise.resolve(),
    nack: () => Promise.resolve(),
    reapExpired: () => Promise.resolve([]),
  };
  const orchestrator = new WorkflowOrchestrator(
    stores.projects,
    stores.runs,
    stores.stepRuns,
    stores.stepAttempts,
    stores.artifacts,
    stores.events,
    workflows,
    harness,
    router,
    metrics,
    registry,
    verifier,
    stores.workspaces,
    stores.clock,
    ids,
    { agentTimeoutMs: 60_000, cancelPollIntervalMs: 10 },
  );
  const service = new ProjectService(
    stores.projects,
    stores.runs,
    stores.stepRuns,
    stores.stepAttempts,
    stores.artifacts,
    stores.events,
    queue,
    workflows,
    harness,
    router,
    stores.workspaces,
    stores.clock,
    ids,
  );
  return { ...stores, ids, executor, orchestrator, service, enqueued };
}

type Harness = ReturnType<typeof makeHarness>;

async function seedRun(harness: Harness): Promise<void> {
  const now = harness.clock.now().toISOString();
  await harness.projects.create({
    id: 'project-1',
    name: 'Run controls fixture',
    workflowId: WORKFLOW.id,
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
    currentRunId: 'run-1',
  });
  await harness.runs.create({
    id: 'run-1',
    projectId: 'project-1',
    workflowId: WORKFLOW.id,
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

async function completeRun(harness: Harness): Promise<void> {
  await seedRun(harness);
  await harness.orchestrator.runProject('project-1', undefined, 'run-1');
  expect((await harness.runs.get('run-1'))?.status).toBe('completed');
}

function liveStepRun(harness: Harness, stepId: string): StepRun {
  const live = harness.stepRuns.byStepId('run-1', stepId).filter((step) => !step.invalidatedAt);
  expect(live).toHaveLength(1);
  return live[0]!;
}

describe('pause and resume at step boundaries (#7)', () => {
  it('pauses between steps, records the snapshot, and never starts the next step', async () => {
    const harness = makeHarness({ plan: 'gated' });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('plan')).toBe(1);
    });
    await harness.service.pauseRun('run-1');
    // Idempotent: a second pause is a no-op.
    await harness.service.pauseRun('run-1');
    harness.executor.release('plan');
    await running; // resolves cleanly: the worker acks a paused run

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('paused');
    expect(run?.pause?.resumeNodeId).toBe('implement');
    expect(run?.pause?.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run?.pause?.harnessVersion).toBe('harness-1');
    expect(run?.pause?.workspaceHead).toBe('initial-head');
    expect(run?.pause?.artifactHashes).toHaveProperty('plan');

    expect(harness.stepRuns.byStepId('run-1', 'plan')[0]?.status).toBe('completed');
    expect(harness.executor.started('implement')).toBe(0);
    expect((await harness.projects.get('project-1'))?.status).toBe('paused');
    expect(harness.events.types().filter((type) => type === 'run.pause_requested')).toHaveLength(1);
    expect(harness.events.types()).toContain('run.paused');
  });

  it('resumes after an API/worker restart without repeating completed side effects', async () => {
    const stores = makeStores();
    const first = makeHarness({ plan: 'gated' }, stores);
    await seedRun(first);
    const running = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(first.executor.started('plan')).toBe(1);
    });
    await first.service.pauseRun('run-1');
    first.executor.release('plan');
    await running;

    // Fresh orchestrator/service instances over the same persisted state.
    const second = makeHarness({}, stores);
    const resumed = await second.service.resumeRun('run-1');
    expect(resumed.status).toBe('queued');
    expect(second.enqueued).toHaveLength(1);

    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    const run = await second.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.pause).toBeUndefined();
    // The completed plan step was reused, not re-executed.
    expect(second.executor.started('plan')).toBe(0);
    expect(stores.artifacts.named('plan')).toHaveLength(1);
    expect(second.executor.started('implement')).toBe(1);
    expect(second.executor.started('review')).toBe(1);
    expect(stores.workspaces.commits).toHaveLength(1);
    expect(stores.events.types()).toContain('step.reused');
    // Dedupe keys keep the replayed lifecycle events single.
    expect(stores.events.types().filter((type) => type === 'project.started')).toHaveLength(1);
    expect((await stores.projects.get('project-1'))?.status).toBe('completed');
  });

  it('blocks resume with actionable diagnostics when workspace or inputs drifted', async () => {
    const harness = makeHarness({ plan: 'gated' });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('plan')).toBe(1);
    });
    await harness.service.pauseRun('run-1');
    harness.executor.release('plan');
    await running;

    // Drift: workspace HEAD moved and the plan artifact was edited.
    harness.workspaces.current = 'tampered-head';
    await harness.artifacts.put({
      projectId: 'project-1',
      name: 'plan',
      content: 'edited by hand',
      createdBy: 'user',
    });

    const rejection = harness.service.resumeRun('run-1');
    await expect(rejection).rejects.toThrow(ResumeBlockedError);
    const error = (await rejection.catch((cause: unknown) => cause)) as ResumeBlockedError;
    const fields = error.diagnostics.map((item) => item.field);
    expect(fields).toContain('workspaceHead');
    expect(fields).toContain('artifact:plan');

    expect((await harness.runs.get('run-1'))?.status).toBe('paused');
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.events.types()).toContain('run.resume_blocked');
  });
});

describe('step retry with controlled invalidation (#8)', () => {
  it('retries only the reviewer and preserves downstream outputs', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const review = liveStepRun(harness, 'review');

    await harness.service.retryStep('run-1', review.id, { mode: 'preserve' });
    const requeued = await harness.runs.get('run-1');
    expect(requeued?.status).toBe('queued');
    expect(requeued?.retry?.stepId).toBe('review');
    expect((await harness.stepRuns.get('run-1', review.id))?.invalidatedAt).toBeDefined();

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('plan')).toBe(1);
    expect(harness.executor.started('implement')).toBe(1);
    expect(harness.executor.started('review')).toBe(2);
    expect(harness.artifacts.named('review')).toHaveLength(2);
    expect(harness.artifacts.named('verification-report')).toHaveLength(1);
    // History preserved: the original review step run still exists.
    expect(harness.stepRuns.byStepId('run-1', 'review')).toHaveLength(2);
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.retry).toBeUndefined();
    expect(harness.events.types()).toContain('step.retry_requested');
  });

  it('preserve mode keeps downstream outputs even when their inputs changed', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');

    await harness.service.retryStep('run-1', implement.id, { mode: 'preserve' });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.artifacts.named('implementation')).toHaveLength(2);
    // review consumed implementation r1, r2 now exists — preserved anyway.
    expect(harness.executor.started('review')).toBe(1);
    expect(harness.artifacts.named('review')).toHaveLength(1);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('retries the developer from its checkpoint, invalidates downstream, and honors the model override', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');
    const originalAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === implement.id);
    expect(originalAttempt?.checkpoint).toBeDefined();
    expect(originalAttempt?.commit).toBeDefined();

    const plan = await harness.service.retryPlan('run-1', implement.id);
    expect(plan.downstream.map((step) => step.stepId)).toEqual(['review', 'verify']);
    expect(plan.artifacts).toContain('review');
    expect(plan.artifacts).toContain('verification-report');

    await harness.service.retryStep('run-1', implement.id, {
      mode: 'invalidate',
      override: { provider: 'codex', model: 'alt-model' },
    });
    for (const stepId of ['implement', 'review', 'verify']) {
      expect(
        harness.stepRuns
          .byStepId('run-1', stepId)
          .every((step) => step.invalidatedAt !== undefined),
      ).toBe(true);
    }

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // Mutable step restarted from the checkpoint its original attempt recorded.
    expect(harness.workspaces.rollbacks).toContain(originalAttempt!.checkpoint!);
    expect(harness.executor.started('plan')).toBe(1);
    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.executor.started('review')).toBe(2);
    expect(harness.artifacts.named('implementation')).toHaveLength(2);
    expect(harness.artifacts.named('review')).toHaveLength(2);
    expect(harness.artifacts.named('verification-report')).toHaveLength(2);

    const newImplement = liveStepRun(harness, 'implement');
    const newAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === newImplement.id);
    expect(newAttempt?.modelId).toBe('model-2');
    expect(newAttempt?.model).toBe('alt-model');
    // Old attempt history is untouched.
    expect(
      await harness.stepAttempts.get('run-1', implement.id, originalAttempt!.id),
    ).toMatchObject({ status: 'succeeded' });
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('rejects retry while the run is not finished and rejects unknown overrides', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const review = liveStepRun(harness, 'review');

    await expect(
      harness.service.retryStep('run-1', review.id, {
        mode: 'preserve',
        override: { provider: 'codex', model: 'not-a-model' },
      }),
    ).rejects.toThrow(/No catalog model/);

    await harness.service.retryStep('run-1', review.id, { mode: 'preserve' });
    await expect(
      harness.service.retryStep('run-1', review.id, { mode: 'preserve' }),
    ).rejects.toThrow(/only completed or failed runs/);
  });
});

describe('idempotency across attempts, artifacts, events and commits (#9)', () => {
  it('crash after artifact put: replay adopts the artifact without re-executing or re-committing', async () => {
    const harness = makeHarness();
    await seedRun(harness);
    harness.artifacts.onAfterPut = (name) => {
      if (name === 'implementation') harness.power.on = false;
    };

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /simulated power loss/,
    );
    harness.artifacts.onAfterPut = undefined;
    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    expect(harness.workspaces.commits).toHaveLength(1);

    harness.power.on = true;
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // The step did not run again; its interrupted records were finalized.
    expect(harness.executor.started('implement')).toBe(1);
    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    expect(harness.workspaces.commits).toHaveLength(1);
    const implement = liveStepRun(harness, 'implement');
    expect(implement.status).toBe('completed');
    const attempts = await harness.stepAttempts.list('run-1', implement.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('succeeded');
    expect(attempts[0]?.outputArtifacts[0]?.name).toBe('implementation');
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(harness.events.types()).toContain('step.reused');
  });

  it('crash after commit but before artifact put: replay re-executes without duplicating the artifact', async () => {
    const harness = makeHarness();
    await seedRun(harness);
    harness.workspaces.onAfterCommit = () => {
      harness.power.on = false;
    };

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /simulated power loss/,
    );
    harness.workspaces.onAfterCommit = undefined;
    expect(harness.artifacts.named('implementation')).toHaveLength(0);

    harness.power.on = true;
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    const stepRuns = harness.stepRuns.byStepId('run-1', 'implement');
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]?.status).toBe('failed');
    expect(stepRuns[0]?.error?.message).toMatch(/Interrupted/);
    expect(stepRuns[1]?.status).toBe('completed');
    // The interrupted attempt is preserved as failed history, never rewritten.
    const staleAttempts = await harness.stepAttempts.list('run-1', stepRuns[0]!.id);
    expect(staleAttempts[0]?.status).toBe('failed');
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('crash before queue ack: redelivery of a completed run is a no-op', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const stepCount = harness.stepRuns.store.size;
    const attemptCount = harness.stepAttempts.store.size;
    const artifactCount = harness.artifacts.artifacts.length;
    const eventCount = harness.events.events.length;

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.stepRuns.store.size).toBe(stepCount);
    expect(harness.stepAttempts.store.size).toBe(attemptCount);
    expect(harness.artifacts.artifacts.length).toBe(artifactCount);
    expect(harness.events.events.length).toBe(eventCount);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('keeps the run -> step -> attempt -> artifact -> commit trail queryable', async () => {
    const harness = makeHarness();
    await completeRun(harness);

    const detail = await harness.service.getRunDetail('run-1');
    expect(detail.run.id).toBe('run-1');
    expect(detail.steps.map((entry) => entry.step.stepId)).toEqual([
      'plan',
      'implement',
      'review',
      'verify',
    ]);
    const implement = detail.steps.find((entry) => entry.step.stepId === 'implement');
    const attempt = implement?.attempts[0];
    expect(attempt?.status).toBe('succeeded');
    expect(attempt?.commit).toBe(harness.workspaces.commits[0]);
    const output = attempt?.outputArtifacts[0];
    expect(output?.name).toBe('implementation');
    const artifact = await harness.artifacts.getRevision(
      'project-1',
      output!.name,
      output!.revision,
    );
    expect(artifact?.metadata.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
