import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it, vi } from 'vitest';
import {
  EXECUTION_PROTOCOL_VERSION,
  ModelDefinitionSchema,
  RouteDecisionSchema,
  WorkflowDefinitionSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type ArtifactMetadata,
  type ExecutionRequest,
  type ExecutionResult,
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
  InvalidStateTransitionError,
  RunCancelledError,
  SystemClock,
  VersionConflictError,
  toExecutionResult,
  transitionWorkflowRun,
  type ApprovalDecisionRepository,
  type ApprovalRequestRepository,
  type ArtifactStore,
  type EventStore,
  type ExecutionPlane,
  type ExecutionStatus,
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
import { DEFAULT_POLICY, InMemoryPolicies } from './testing/harness.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

const WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'cancel-test-v1',
  name: 'Cancellation fixture',
  description: 'Planner, developer and verifier nodes for cancellation tests.',
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
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
      maxAttempts: 1,
    },
    {
      id: 'verify',
      type: 'verify',
      title: 'Verify',
      outputArtifact: 'verification-report',
    },
  ],
});

const MODEL = ModelDefinitionSchema.parse({
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
});

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class InMemoryProjects implements ProjectRepository {
  private readonly store = new Map<string, Project>();
  create(project: Project): Promise<void> {
    this.store.set(project.id, { ...project });
    return Promise.resolve();
  }
  get(projectId: string): Promise<Project | null> {
    const project = this.store.get(projectId);
    return Promise.resolve(project ? { ...project } : null);
  }
  update(project: Project, expectedVersion: number): Promise<Project> {
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
  create(run: WorkflowRun): Promise<void> {
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
  create(step: StepRun): Promise<void> {
    this.store.set(`${step.runId}/${step.id}`, { ...step });
    return Promise.resolve();
  }
  get(runId: string, stepRunId: string): Promise<StepRun | null> {
    const step = this.store.get(`${runId}/${stepRunId}`);
    return Promise.resolve(step ? { ...step } : null);
  }
  list(runId: string): Promise<StepRun[]> {
    return Promise.resolve([...this.store.values()].filter((step) => step.runId === runId));
  }
  update(step: StepRun, expectedVersion: number): Promise<StepRun> {
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
}

class InMemoryStepAttempts implements StepAttemptRepository {
  readonly store = new Map<string, StepAttempt>();
  create(attempt: StepAttempt): Promise<void> {
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

class InMemoryApprovalRequests implements ApprovalRequestRepository {
  readonly store = new Map<string, ApprovalRequest>();
  create(request: ApprovalRequest): Promise<void> {
    this.store.set(`${request.runId}/${request.id}`, { ...request });
    return Promise.resolve();
  }
  get(runId: string, requestId: string): Promise<ApprovalRequest | null> {
    const request = this.store.get(`${runId}/${requestId}`);
    return Promise.resolve(request ? { ...request } : null);
  }
  getForStepRun(runId: string, stepRunId: string): Promise<ApprovalRequest | null> {
    const match = [...this.store.values()].find(
      (request) => request.runId === runId && request.stepRunId === stepRunId,
    );
    return Promise.resolve(match ? { ...match } : null);
  }
  list(runId: string): Promise<ApprovalRequest[]> {
    return Promise.resolve([...this.store.values()].filter((request) => request.runId === runId));
  }
}

class InMemoryApprovalDecisions implements ApprovalDecisionRepository {
  readonly store = new Map<string, ApprovalDecision>();
  create(decision: ApprovalDecision): Promise<void> {
    this.store.set(`${decision.runId}/${decision.requestId}`, { ...decision });
    return Promise.resolve();
  }
  get(runId: string, requestId: string): Promise<ApprovalDecision | null> {
    const decision = this.store.get(`${runId}/${requestId}`);
    return Promise.resolve(decision ? { ...decision } : null);
  }
}

class InMemoryArtifacts implements ArtifactStore {
  readonly artifacts: StoredArtifact[] = [];
  readonly blobs: Array<{ metadata: ArtifactMetadata; buffer: Buffer }> = [];
  put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
  }): Promise<StoredArtifact> {
    const revision = this.artifacts.filter(
      (artifact) =>
        artifact.metadata.projectId === input.projectId && artifact.metadata.name === input.name,
    ).length;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision: revision + 1,
      contentType: input.contentType ?? 'application/json',
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      sha256: 'f'.repeat(64),
    };
    const stored: StoredArtifact = { metadata, content: input.content };
    this.artifacts.push(stored);
    return Promise.resolve(stored);
  }
  async putBlob(
    input: { projectId: string; name: string; contentType: string; createdBy: string },
    source: Readable,
  ): Promise<ArtifactMetadata> {
    const content = await buffer(source);
    const revision =
      this.artifacts.filter(
        (artifact) =>
          artifact.metadata.projectId === input.projectId && artifact.metadata.name === input.name,
      ).length +
      this.blobs.filter(
        (entry) =>
          entry.metadata.projectId === input.projectId && entry.metadata.name === input.name,
      ).length;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision: revision + 1,
      contentType: input.contentType,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      storage: 'blob',
      sizeBytes: content.byteLength,
      sha256: 'f'.repeat(64),
    };
    this.blobs.push({ metadata, buffer: content });
    return metadata;
  }
  getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null> {
    const entry = this.blobs.find(
      (item) =>
        item.metadata.projectId === projectId &&
        item.metadata.name === name &&
        item.metadata.revision === revision,
    );
    return Promise.resolve(entry ? Readable.from(entry.buffer) : null);
  }
  getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    const matches = this.artifacts.filter(
      (artifact) => artifact.metadata.projectId === projectId && artifact.metadata.name === name,
    );
    return Promise.resolve(matches.at(-1) ?? null);
  }
  getRevision(): Promise<StoredArtifact | null> {
    return Promise.resolve(null);
  }
  listLatest(): Promise<StoredArtifact[]> {
    return Promise.resolve([...this.artifacts]);
  }
  listMetadata(): Promise<ArtifactMetadata[]> {
    return Promise.resolve(this.artifacts.map((artifact) => artifact.metadata));
  }
  named(name: string): StoredArtifact[] {
    return this.artifacts.filter((artifact) => artifact.metadata.name === name);
  }
}

class InMemoryEvents implements EventStore {
  readonly events: ProjectEvent[] = [];
  append(event: ProjectEvent): Promise<void> {
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

class FakeWorkspaces implements WorkspaceManager {
  readonly checkpoints: string[] = [];
  readonly rollbacks: string[] = [];
  readonly commits: string[] = [];
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
    return Promise.resolve({ requestPath: 'request.md', schemaPath: 'schema.json' });
  }
  ensureGit(): Promise<void> {
    return Promise.resolve();
  }
  checkpoint(): Promise<string> {
    const ref = `checkpoint-${String(this.checkpoints.length + 1)}`;
    this.checkpoints.push(ref);
    return Promise.resolve(ref);
  }
  rollback(_projectId: string, ref: string): Promise<void> {
    this.rollbacks.push(ref);
    return Promise.resolve();
  }
  preserveDraft(_projectId: string, runId: string, verifiedCheckpoint: string) {
    this.rollbacks.push(verifiedCheckpoint);
    return Promise.resolve({
      draftBranch: `draft/${runId}`,
      draftCommit: 'draft-commit',
      created: true,
    });
  }
  discardDraft(): Promise<void> {
    return Promise.resolve();
  }
  commit(_projectId: string, message: string): Promise<string | null> {
    this.commits.push(message);
    return Promise.resolve(`commit-${String(this.commits.length)}`);
  }
  head(): Promise<string | null> {
    return Promise.resolve('initial-head');
  }
  diff(_projectId: string, fromRef: string, toRef: string): Promise<string> {
    return Promise.resolve(`diff --fake ${fromRef}..${toRef}`);
  }
  restoreTree(): Promise<void> {
    return Promise.resolve();
  }
  createBranch(_projectId: string, ref: string): Promise<string> {
    return Promise.resolve(ref);
  }
}

type ExecutorBehavior = 'instant' | 'reject-on-abort' | 'resolve-on-abort';

class ControllableExecutor implements ExecutionPlane {
  readonly started = new Set<string>();
  readonly completed = new Set<string>();
  constructor(private readonly behaviors: Record<string, ExecutorBehavior>) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      const result = await this.executeInternal({ ...request.agent, cwd: 'unused' }, signal);
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      return toExecutionResult(request.executionId, error);
    }
  }

  async cancel(): Promise<void> {}

  async status(executionId: string): Promise<ExecutionStatus> {
    return { executionId, state: this.completed.has(executionId) ? 'completed' : 'running' };
  }

  private executeInternal(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.started.add(request.stepId);
    const behavior = this.behaviors[request.stepId] ?? 'instant';
    if (behavior === 'instant') {
      this.completed.add(request.stepId);
      return Promise.resolve(this.result(request));
    }
    return new Promise((resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          if (behavior === 'resolve-on-abort') {
            this.completed.add(request.stepId);
            resolve(this.result(request));
          } else {
            reject(new RunCancelledError(request.runId));
          }
        },
        { once: true },
      );
    });
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

class ControllableVerifier implements VerificationService {
  started = 0;
  constructor(private readonly blocking: boolean) {}
  verify(_input: unknown, signal?: AbortSignal): Promise<VerificationReport> {
    this.started += 1;
    if (!this.blocking) {
      return Promise.resolve({
        schemaVersion: '1',
        approved: true,
        packageManager: 'npm',
        summary: 'ok',
        commands: [],
        createdAt: new Date().toISOString(),
      });
    }
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new RunCancelledError()), { once: true });
    });
  }
}

function makeHarness(
  behaviors: Record<string, ExecutorBehavior>,
  options: { blockingVerifier?: boolean } = {},
) {
  const clock = new SystemClock();
  const ids = new SequentialIds();
  const projects = new InMemoryProjects();
  const runs = new InMemoryRuns();
  const stepRuns = new InMemoryStepRuns();
  const stepAttempts = new InMemoryStepAttempts();
  const approvalRequests = new InMemoryApprovalRequests();
  const approvalDecisions = new InMemoryApprovalDecisions();
  const artifacts = new InMemoryArtifacts();
  const events = new InMemoryEvents();
  const workspaces = new FakeWorkspaces();
  const executor = new ControllableExecutor(behaviors);
  const verifier = new ControllableVerifier(options.blockingVerifier ?? false);
  const workflows: WorkflowRepository = {
    get: () => Promise.resolve(WORKFLOW),
    list: () => Promise.resolve([WORKFLOW]),
  };
  const harness: HarnessRepository = {
    select: () => Promise.resolve({ version: '1', files: [], combined: '' }),
    version: () => Promise.resolve('1'),
  };
  const router: ModelRouter = {
    route: (profile) =>
      Promise.resolve(
        RouteDecisionSchema.parse({
          routeId: 'route-1',
          createdAt: new Date().toISOString(),
          profile,
          selected: {
            model: MODEL,
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
    catalog: () => Promise.resolve([MODEL]),
  };
  const metrics: MetricsRepository = {
    get: () => Promise.resolve(null),
    record: vi.fn(() => Promise.resolve()),
    recordQuality: vi.fn(() => Promise.resolve()),
  };
  const queue: JobQueue = {
    enqueue: () => Promise.resolve(),
    claim: () => Promise.resolve(null),
    heartbeat: (job) => Promise.resolve(job),
    ack: () => Promise.resolve(),
    nack: () => Promise.resolve(),
    reapExpired: () => Promise.resolve([]),
  };
  const orchestrator = new WorkflowOrchestrator(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    events,
    workflows,
    new InMemoryPolicies(DEFAULT_POLICY),
    harness,
    router,
    metrics,
    executor,
    verifier,
    workspaces,
    clock,
    ids,
    { agentTimeoutMs: 60_000, cancelPollIntervalMs: 10 },
  );
  const service = new ProjectService(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    events,
    queue,
    workflows,
    new InMemoryPolicies(DEFAULT_POLICY),
    harness,
    router,
    workspaces,
    clock,
    ids,
  );
  return {
    clock,
    projects,
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    workspaces,
    executor,
    verifier,
    orchestrator,
    service,
  };
}

async function seedRun(harness: ReturnType<typeof makeHarness>): Promise<void> {
  const now = harness.clock.now().toISOString();
  await harness.projects.create({
    id: 'project-1',
    name: 'Cancellation fixture',
    workflowId: WORKFLOW.id,
    policyId: 'default',
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

async function statusByStepId(
  harness: ReturnType<typeof makeHarness>,
): Promise<Record<string, string>> {
  const steps = await harness.stepRuns.list('run-1');
  return Object.fromEntries(steps.map((step) => [step.stepId, step.status]));
}

describe('cancellation during a workflow run', () => {
  it('cancels during the planner step and finalizes run, step and attempt as cancelled', async () => {
    const harness = makeHarness({ plan: 'reject-on-abort' });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started.has('plan')).toBe(true);
    });

    await harness.service.cancelRun('run-1');
    await running;

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('cancelled');
    expect(run?.completedAt).toBeDefined();
    expect(await statusByStepId(harness)).toEqual({ plan: 'cancelled' });
    expect(harness.stepAttempts.all().map((attempt) => attempt.status)).toEqual(['cancelled']);
    expect(harness.artifacts.named('plan')).toHaveLength(0);
    expect((await harness.projects.get('project-1'))?.status).toBe('cancelled');

    const types = harness.events.types();
    expect(types).toContain('run.cancel_requested');
    expect(types).toContain('run.cancelled');
    expect(types).not.toContain('project.completed');
    expect(types).not.toContain('project.failed');
    expect(harness.executor.started.has('implement')).toBe(false);
  });

  it('cancels during the developer step, restores the git checkpoint and promotes no artifact even if the CLI result arrives after the abort', async () => {
    const harness = makeHarness({ implement: 'resolve-on-abort' });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started.has('implement')).toBe(true);
    });

    await harness.service.cancelRun('run-1');
    await running;

    // The executor produced a result after the abort, but nothing was promoted.
    expect(harness.executor.completed.has('implement')).toBe(true);
    expect(harness.artifacts.named('implementation')).toHaveLength(0);
    expect(harness.workspaces.commits).toHaveLength(0);
    expect(harness.workspaces.checkpoints).toEqual(['checkpoint-1']);
    expect(harness.workspaces.rollbacks).toEqual(['checkpoint-1']);

    const statuses = await statusByStepId(harness);
    expect(statuses.plan).toBe('completed');
    expect(statuses.implement).toBe('cancelled');
    expect((await harness.runs.get('run-1'))?.status).toBe('cancelled');
    expect(harness.events.types()).toContain('run.cancelled');
  });

  it('cancels during the verifier step without promoting a verification report', async () => {
    const harness = makeHarness({}, { blockingVerifier: true });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.verifier.started).toBe(1);
    });

    await harness.service.cancelRun('run-1');
    await running;

    const statuses = await statusByStepId(harness);
    expect(statuses.plan).toBe('completed');
    expect(statuses.implement).toBe('completed');
    expect(statuses.verify).toBe('cancelled');
    expect(harness.artifacts.named('verification-report')).toHaveLength(0);
    // The developer step committed before the cancel arrived, so its work stays put.
    expect(harness.workspaces.commits).toHaveLength(1);
    expect(harness.workspaces.rollbacks).toHaveLength(0);
    expect((await harness.runs.get('run-1'))?.status).toBe('cancelled');
    const attempts = harness.stepAttempts.all();
    expect(attempts.filter((attempt) => attempt.status === 'cancelled')).toHaveLength(1);
  });

  it('confirms a cancel requested while the run was still queued without executing any step', async () => {
    const harness = makeHarness({});
    await seedRun(harness);

    await harness.service.cancelRun('run-1');
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('cancelled');
    expect(harness.executor.started.size).toBe(0);
    expect(await harness.stepRuns.list('run-1')).toHaveLength(0);
    expect(harness.events.types()).toContain('run.cancelled');
  });
});

describe('ProjectService.cancelRun', () => {
  it('is idempotent and emits run.cancel_requested only once', async () => {
    const harness = makeHarness({});
    await seedRun(harness);

    const first = await harness.service.cancelRun('run-1');
    const second = await harness.service.cancelRun('run-1');

    expect(first.status).toBe('cancel_requested');
    expect(second.status).toBe('cancel_requested');
    expect(harness.events.types().filter((type) => type === 'run.cancel_requested')).toHaveLength(
      1,
    );
  });

  it('rejects cancelling a run that already finished', async () => {
    const harness = makeHarness({});
    await seedRun(harness);
    let run = await harness.runs.get('run-1');
    run = await harness.runs.update(
      transitionWorkflowRun(run!, 'running', harness.clock.now()),
      run!.version,
    );
    await harness.runs.update(
      transitionWorkflowRun(run, 'completed', harness.clock.now()),
      run.version,
    );

    await expect(harness.service.cancelRun('run-1')).rejects.toThrow(InvalidStateTransitionError);
  });
});
