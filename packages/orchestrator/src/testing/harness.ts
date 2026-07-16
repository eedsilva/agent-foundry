import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  ModelDefinitionSchema,
  ProjectPolicySchema,
  RouteDecisionSchema,
  WorkflowDefinitionSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ApprovalAction,
  type ApprovalDecision,
  type ApprovalRequest,
  type ArtifactMetadata,
  type ExecutorHealth,
  type ModelDefinition,
  type Project,
  type ProjectEvent,
  type ProjectPolicy,
  type StepAttempt,
  type StepRun,
  type StoredArtifact,
  type VerificationReport,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import {
  ExecutionError,
  NotFoundError,
  SystemClock,
  VersionConflictError,
  type AgentExecutor,
  type ApprovalDecisionRepository,
  type ApprovalRequestRepository,
  type ArtifactStore,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type PolicyRepository,
  type ProjectRepository,
  type StepAttemptRepository,
  type StepRunRepository,
  type VerificationService,
  type WorkflowRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { ProjectService } from '../project-service.js';
import { WorkflowOrchestrator } from '../workflow-orchestrator.js';

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

export const DEFAULT_POLICY: ProjectPolicy = ProjectPolicySchema.parse({
  schemaVersion: '1',
  id: 'default',
  version: 1,
});

export class InMemoryPolicies implements PolicyRepository {
  constructor(public policy: ProjectPolicy) {}
  get(policyId: string): Promise<ProjectPolicy> {
    if (policyId !== this.policy.id) {
      return Promise.reject(new NotFoundError(`Policy ${policyId} not found`));
    }
    return Promise.resolve({ ...this.policy });
  }
}

export interface PowerSwitch {
  on: boolean;
}

export function checkPower(power: PowerSwitch): void {
  if (!power.on) throw new Error('simulated power loss');
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

export class InMemoryProjects implements ProjectRepository {
  private readonly store = new Map<string, Project>();
  onBeforeUpdate: ((project: Project) => void) | undefined;
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
    this.onBeforeUpdate?.(project);
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

export class InMemoryRuns implements WorkflowRunRepository {
  private readonly store = new Map<string, WorkflowRun>();
  onBeforeUpdate: ((run: WorkflowRun) => void) | undefined;
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
    this.onBeforeUpdate?.(run);
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

export class InMemoryStepRuns implements StepRunRepository {
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

export class InMemoryStepAttempts implements StepAttemptRepository {
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

export class InMemoryApprovalRequests implements ApprovalRequestRepository {
  readonly store = new Map<string, ApprovalRequest>();
  constructor(private readonly power: PowerSwitch) {}
  create(request: ApprovalRequest): Promise<void> {
    checkPower(this.power);
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
    return Promise.resolve(
      [...this.store.values()]
        .filter((request) => request.runId === runId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }
}

export class InMemoryApprovalDecisions implements ApprovalDecisionRepository {
  readonly store = new Map<string, ApprovalDecision>();
  constructor(private readonly power: PowerSwitch) {}
  create(decision: ApprovalDecision): Promise<void> {
    checkPower(this.power);
    const key = `${decision.runId}/${decision.requestId}`;
    // Matches FileApprovalDecisionRepository: create-only, second writer loses.
    if (this.store.has(key)) {
      return Promise.reject(
        new Error(`Approval request ${decision.requestId} already has a decision`),
      );
    }
    this.store.set(key, { ...decision });
    return Promise.resolve();
  }
  get(runId: string, requestId: string): Promise<ApprovalDecision | null> {
    const decision = this.store.get(`${runId}/${requestId}`);
    return Promise.resolve(decision ? { ...decision } : null);
  }
}

export class InMemoryArtifacts implements ArtifactStore {
  readonly artifacts: StoredArtifact[] = [];
  onAfterPut?: ((name: string) => void) | undefined;
  onListMetadata?: (() => Promise<void>) | undefined;
  constructor(private readonly power: PowerSwitch) {}
  put(input: Parameters<ArtifactStore['put']>[0]): Promise<StoredArtifact> {
    checkPower(this.power);
    const existing = input.sourceDecisionId
      ? this.named(input.name).find(
          (artifact) => artifact.metadata.sourceDecisionId === input.sourceDecisionId,
        )
      : undefined;
    if (existing) return Promise.resolve(existing);
    const revision = this.named(input.name).length + 1;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision,
      contentType: input.contentType ?? 'application/json',
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.sourceDecisionId ? { sourceDecisionId: input.sourceDecisionId } : {}),
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
  async listMetadata(_projectId?: string, name?: string): Promise<ArtifactMetadata[]> {
    await this.onListMetadata?.();
    const items = name ? this.named(name) : this.artifacts;
    return items.map((artifact) => artifact.metadata);
  }
  named(name: string): StoredArtifact[] {
    return this.artifacts.filter((artifact) => artifact.metadata.name === name);
  }
}

export class InMemoryEvents implements EventStore {
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
export class FakeWorkspaces implements WorkspaceManager {
  readonly checkpoints: string[] = [];
  readonly commits: string[] = [];
  readonly rollbacks: string[] = [];
  current = 'initial-head';
  dirty = false;
  onBeforeCheckpoint?: (() => void) | undefined;
  onAfterCheckpoint?: (() => void) | undefined;
  onBeforeCommit?: (() => void) | undefined;
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
    this.onBeforeCheckpoint?.();
    if (this.dirty) {
      this.current = this.nextSha();
      this.dirty = false;
    }
    this.checkpoints.push(this.current);
    this.onAfterCheckpoint?.();
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
    this.onBeforeCommit?.();
    // Re-checked so a hook that flips power off pre-empts the commit itself,
    // not just the caller's next write (mirrors checkpoint()'s failure mode
    // one level earlier, where the hook's write is the mutation being gated).
    checkPower(this.power);
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

export type StepBehavior =
  | 'instant'
  | 'gated'
  | { kind: 'fail-once'; error: () => Error }
  | { kind: 'fail-always'; error: () => Error }
  | { kind: 'hang-until-abort' };

/** Mirrors execa's own timeout message, wrapped the way base-cli-executor reports a hard deadline. */
export function timeoutError(): ExecutionError {
  return new ExecutionError('Command timed out after 300000 milliseconds: codex ...', {
    provider: 'mock',
    stderr: '',
  });
}

/** Mirrors base-cli-executor.ts:141-149 — a nonzero exit whose stderr carries the provider's rate-limit text. */
export function rateLimitError(): ExecutionError {
  return new ExecutionError('CLI exited with a failure status', {
    exitCode: 1,
    stderr: '429 Too Many Requests: rate limit reached',
  });
}

/** Mirrors json-output.ts:4-17 — stdout that never parsed into a valid agent artifact. */
export function invalidOutputError(): ExecutionError {
  return new ExecutionError('Agent did not return a valid artifact JSON object', {
    stdout: 'not json at all',
  });
}

export class ControllableExecutor implements AgentExecutor {
  readonly provider = 'codex';
  readonly startCounts = new Map<string, number>();
  private readonly gates = new Map<string, () => void>();
  constructor(
    private readonly behaviors: Record<string, StepBehavior>,
    private readonly workspaces: FakeWorkspaces,
  ) {}

  execute(request: AgentExecutionRequest, signal?: AbortSignal): Promise<AgentExecutionResult> {
    const count = (this.startCounts.get(request.stepId) ?? 0) + 1;
    this.startCounts.set(request.stepId, count);
    const behavior = this.behaviors[request.stepId] ?? 'instant';
    // Simulates a CLI that writes to the workspace before it reports success or failure.
    const touch = (): void => {
      if (request.mutatesWorkspace) this.workspaces.touch();
    };

    if (behavior === 'instant') {
      touch();
      return Promise.resolve(this.result(request));
    }
    if (behavior === 'gated') {
      return new Promise((resolve) => {
        this.gates.set(request.stepId, () => {
          touch();
          resolve(this.result(request));
        });
      });
    }
    if (behavior.kind === 'hang-until-abort') {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const shouldFail = behavior.kind === 'fail-always' || count === 1;
    touch();
    if (shouldFail) return Promise.reject(behavior.error());
    return Promise.resolve(this.result(request));
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

export interface Stores {
  power: PowerSwitch;
  clock: SystemClock;
  projects: InMemoryProjects;
  runs: InMemoryRuns;
  stepRuns: InMemoryStepRuns;
  stepAttempts: InMemoryStepAttempts;
  approvalRequests: InMemoryApprovalRequests;
  approvalDecisions: InMemoryApprovalDecisions;
  artifacts: InMemoryArtifacts;
  events: InMemoryEvents;
  workspaces: FakeWorkspaces;
  harnessVersion: { value: string };
}

export function makeStores(): Stores {
  const power: PowerSwitch = { on: true };
  return {
    power,
    clock: new SystemClock(),
    projects: new InMemoryProjects(power),
    runs: new InMemoryRuns(power),
    stepRuns: new InMemoryStepRuns(power),
    stepAttempts: new InMemoryStepAttempts(power),
    approvalRequests: new InMemoryApprovalRequests(power),
    approvalDecisions: new InMemoryApprovalDecisions(power),
    artifacts: new InMemoryArtifacts(power),
    events: new InMemoryEvents(power),
    workspaces: new FakeWorkspaces(power),
    harnessVersion: { value: 'harness-1' },
  };
}

export interface GateOptions {
  actions?: ApprovalAction[];
  onReject?: 'end' | 'return-to-step';
  returnToStepId?: string;
  repairArtifact?: string;
}

export function makeHarness(
  behaviors: Record<string, StepBehavior> = {},
  existing?: Stores,
  opts: { fallback?: boolean; gate?: GateOptions; policy?: ProjectPolicy } = {},
) {
  const stores = existing ?? makeStores();
  const ids = new SequentialIds();
  const executor = new ControllableExecutor(behaviors, stores.workspaces);
  const policies = new InMemoryPolicies(opts.policy ?? DEFAULT_POLICY);
  // Fallback recovery needs the mutating step to offer a second candidate.
  // A gate opt inserts an approval-gate node reviewing the review artifact,
  // between 'review' and 'verify', for approval-gate.test.ts.
  const workflow: WorkflowDefinition = WorkflowDefinitionSchema.parse({
    ...WORKFLOW,
    nodes: [
      ...WORKFLOW.nodes.map((node) =>
        opts.fallback && node.id === 'implement' ? { ...node, maxAttempts: 2 } : node,
      ),
    ].flatMap((node) =>
      opts.gate && node.id === 'verify'
        ? [
            {
              id: 'gate',
              type: 'approval-gate' as const,
              title: 'Human review',
              artifact: 'review',
              outputArtifact: 'gate-decision',
              ...opts.gate,
            },
            node,
          ]
        : [node],
    ),
  });
  const verifierInputs: Array<{ policy?: ProjectPolicy | undefined }> = [];
  const verifier: VerificationService = {
    verify: (input) => {
      verifierInputs.push(input);
      return Promise.resolve({
        schemaVersion: '1',
        approved: true,
        packageManager: 'npm',
        summary: 'ok',
        commands: [],
        createdAt: new Date().toISOString(),
      } satisfies VerificationReport);
    },
  };
  const workflows: WorkflowRepository = {
    get: () => Promise.resolve(workflow),
    list: () => Promise.resolve([workflow]),
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
          fallbacks: opts.fallback
            ? [
                {
                  model: MODELS[1]!,
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
              ]
            : [],
          rejected: [],
        }),
      ),
    catalog: () => Promise.resolve(MODELS),
  };
  const metricsRecords: Parameters<MetricsRepository['record']>[0][] = [];
  const metrics: MetricsRepository = {
    get: () => Promise.resolve(null),
    record: (input) => {
      metricsRecords.push(input);
      return Promise.resolve();
    },
    recordQuality: () => Promise.resolve(),
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
    stores.approvalRequests,
    stores.approvalDecisions,
    stores.artifacts,
    stores.events,
    workflows,
    policies,
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
    stores.approvalRequests,
    stores.approvalDecisions,
    stores.artifacts,
    stores.events,
    queue,
    workflows,
    policies,
    harness,
    router,
    stores.workspaces,
    stores.clock,
    ids,
  );
  return {
    ...stores,
    ids,
    executor,
    orchestrator,
    service,
    enqueued,
    metricsRecords,
    policies,
    verifierInputs,
  };
}

export type Harness = ReturnType<typeof makeHarness>;

export async function seedRun(harness: Harness): Promise<void> {
  const now = harness.clock.now().toISOString();
  await harness.projects.create({
    id: 'project-1',
    name: 'Run controls fixture',
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

export async function completeRun(harness: Harness): Promise<void> {
  await seedRun(harness);
  await harness.orchestrator.runProject('project-1', undefined, 'run-1');
  assert.strictEqual((await harness.runs.get('run-1'))?.status, 'completed');
}

/** Counts used to pin "replay/redelivery changes nothing" assertions. */
export interface StoreCounts {
  steps: number;
  attempts: number;
  artifacts: number;
  events: number;
  commits: number;
}

export function snapshotCounts(stores: Stores): StoreCounts {
  return {
    steps: stores.stepRuns.store.size,
    attempts: stores.stepAttempts.store.size,
    artifacts: stores.artifacts.artifacts.length,
    events: stores.events.events.length,
    commits: stores.workspaces.commits.length,
  };
}

export function assertCountsUnchanged(stores: Stores, before: StoreCounts): void {
  assert.deepStrictEqual(snapshotCounts(stores), before);
}

export function liveStepRun(harness: Harness, stepId: string): StepRun {
  const live = harness.stepRuns.byStepId('run-1', stepId).filter((step) => !step.invalidatedAt);
  assert.strictEqual(live.length, 1);
  return live[0]!;
}
