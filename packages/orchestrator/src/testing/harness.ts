import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import {
  EXECUTION_PROTOCOL_VERSION,
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
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutorHealth,
  type ModelDefinition,
  type ModelOverrideRecord,
  type Project,
  type ProjectEvent,
  type ProjectPolicy,
  type QueueJob,
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
  RunCancelledError,
  SystemClock,
  VersionConflictError,
  toExecutionResult,
  type AgentExecutor,
  type ApprovalDecisionRepository,
  type ApprovalRequestRepository,
  type ArtifactBlobPutInput,
  type ArtifactStore,
  type Clock,
  type EventStore,
  type ExecutionPlane,
  type ExecutionStatus,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelOverrideRepository,
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
import type { BrowserVerificationCoordinator } from '../browser-verification-coordinator.js';
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

export const MODELS: ModelDefinition[] = [
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
  onBeforeUpdate: ((run: WorkflowRun) => void | Promise<void>) | undefined;
  onAfterUpdate: ((run: WorkflowRun) => void | Promise<void>) | undefined;
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
  async update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun> {
    checkPower(this.power);
    await this.onBeforeUpdate?.(run);
    const existing = this.store.get(run.id);
    if (!existing) throw new Error(`run ${run.id} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError('workflow-run', run.id, expectedVersion, existing.version);
    }
    const updated = { ...run, version: expectedVersion + 1 };
    this.store.set(run.id, updated);
    await this.onAfterUpdate?.({ ...updated });
    return { ...updated };
  }
}

export class InMemoryModelOverrides implements ModelOverrideRepository {
  private readonly store: ModelOverrideRecord[] = [];

  create(override: Omit<ModelOverrideRecord, 'sequence'>): Promise<ModelOverrideRecord> {
    if (this.store.some((item) => item.id === override.id)) {
      return Promise.reject(new Error(`model-override ${override.id} already exists`));
    }
    const stored = {
      ...structuredClone(override),
      sequence:
        Math.max(
          0,
          ...this.store
            .filter((item) => item.runId === override.runId)
            .map((item) => item.sequence),
        ) + 1,
    };
    this.store.push(stored);
    return Promise.resolve(structuredClone(stored));
  }

  list(runId: string): Promise<ModelOverrideRecord[]> {
    return Promise.resolve(
      this.store
        .filter((item) => item.runId === runId)
        .sort(
          (left, right) =>
            right.sequence - left.sequence ||
            right.createdAt.localeCompare(left.createdAt) ||
            right.id.localeCompare(left.id),
        )
        .map((item) => structuredClone(item)),
    );
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
  onBeforeUpdate?: ((attempt: StepAttempt) => void) | undefined;
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
    this.onBeforeUpdate?.(attempt);
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
  readonly blobs: Array<{ metadata: ArtifactMetadata; buffer: Buffer }> = [];
  onAfterPut?: ((name: string) => void) | undefined;
  constructor(private readonly power: PowerSwitch) {}
  put(input: Parameters<ArtifactStore['put']>[0]): Promise<StoredArtifact> {
    checkPower(this.power);
    const existing = input.idempotencyKey
      ? this.named(input.name).find(
          (artifact) => artifact.metadata.idempotencyKey === input.idempotencyKey,
        )
      : input.sourceDecisionId
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
  async putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata> {
    checkPower(this.power);
    const content = await buffer(source);
    const revision =
      this.named(input.name).length +
      this.blobs.filter((entry) => entry.metadata.name === input.name).length +
      1;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision,
      contentType: input.contentType,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stepRunId ? { stepRunId: input.stepRunId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      storage: 'blob',
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
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

export class InMemoryEvents implements EventStore {
  readonly events: ProjectEvent[] = [];
  onBeforeAppend?: ((event: ProjectEvent) => void) | undefined;
  constructor(private readonly power: PowerSwitch) {}
  append(event: ProjectEvent): Promise<void> {
    checkPower(this.power);
    this.onBeforeAppend?.(event);
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
  readonly drafts: string[] = [];
  readonly draftCommits = new Map<string, string>();
  current = 'initial-head';
  dirty = false;
  onBeforeCheckpoint?: (() => void) | undefined;
  onAfterCheckpoint?: (() => void) | undefined;
  onBeforeCommit?: (() => void) | undefined;
  onAfterCommit?: (() => void) | undefined;
  onAfterPreserveDraft?: (() => void | Promise<void>) | undefined;
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
  async preserveDraft(_projectId: string, runId: string, verifiedCheckpoint: string) {
    checkPower(this.power);
    const draftBranch = `draft/${runId}`;
    const created = !this.drafts.includes(draftBranch);
    if (created) {
      if (this.dirty) this.current = this.nextSha();
      this.drafts.push(draftBranch);
      this.draftCommits.set(draftBranch, this.current);
    }
    const draftCommit = this.draftCommits.get(draftBranch)!;
    this.current = verifiedCheckpoint;
    this.dirty = false;
    await this.onAfterPreserveDraft?.();
    return { draftBranch, draftCommit, created };
  }
  discardDraft(_projectId: string, runId: string, expectedCommit: string): Promise<void> {
    const draftBranch = `draft/${runId}`;
    const current = this.draftCommits.get(draftBranch);
    if (current === undefined) return Promise.resolve();
    if (current !== expectedCommit) {
      return Promise.reject(new Error(`${draftBranch} no longer points to the owned commit`));
    }
    this.draftCommits.delete(draftBranch);
    this.drafts.splice(this.drafts.indexOf(draftBranch), 1);
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
  diff(_projectId: string, fromRef: string, toRef: string): Promise<string> {
    return Promise.resolve(`diff --fake ${fromRef}..${toRef}`);
  }
  restoreTree(_projectId: string, ref: string): Promise<void> {
    this.current = ref;
    this.dirty = true;
    return Promise.resolve();
  }
  readonly branches: string[] = [];
  createBranch(_projectId: string, ref: string, name: string): Promise<string> {
    this.branches.push(name);
    return Promise.resolve(ref);
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

/** Simulates a transport-level failure between control plane and execution plane — not a CLI/domain error. */
export function disconnectError(): Error {
  return new Error('ECONNRESET: execution plane disconnected before the run completed');
}

export class ControllableExecutor implements ExecutionPlane {
  readonly startCounts = new Map<string, number>();
  private readonly gates = new Map<string, () => void>();
  private readonly states = new Map<string, ExecutionStatus['state']>();
  private readonly cancellers = new Map<string, () => void>();
  constructor(
    private readonly behaviors: Record<string, StepBehavior>,
    private readonly workspaces: FakeWorkspaces,
    private readonly output?: (
      request: AgentExecutionRequest,
    ) => AgentExecutionResult['output'] | undefined,
  ) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    this.states.set(request.executionId, 'running');
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancellers.set(request.executionId, () =>
        reject(new RunCancelledError(request.agent.runId)),
      );
    });
    try {
      const result = await Promise.race([
        this.executeInternal({ ...request.agent, cwd: 'unused' }, signal),
        cancelled,
      ]);
      this.states.set(request.executionId, 'completed');
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      // emergency-ceiling.test.ts's 'hang-until-abort' scenario rejects with
      // an EmergencyCeilingError via the aborted signal's `reason` — toExecutionResult
      // rethrows that rather than mapping it, so it keeps propagating as a
      // rejection and the orchestrator's own `instanceof EmergencyCeilingError`
      // handling downstream still sees it.
      const result = toExecutionResult(request.executionId, error);
      this.states.set(request.executionId, result.state);
      return result;
    } finally {
      this.cancellers.delete(request.executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.cancellers.get(executionId)?.();
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    return { executionId, state: this.states.get(executionId) ?? 'pending' };
  }

  private executeInternal(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
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
      output: this.output?.(request) ?? {
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

/**
 * Bridges an ExecutionPlane double (e.g. ControllableExecutor) back to the
 * AgentExecutor shape that ExecutorRegistry-based callers still expect.
 * ExecutionPlane.submit never rejects — a failed/cancelled run resolves with
 * `state`; this restores AgentExecutor's reject-on-failure contract.
 */
export class AgentExecutorFromExecutionPlane implements AgentExecutor {
  readonly provider = 'mock';
  constructor(private readonly plane: ExecutionPlane) {}

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const { cwd: _cwd, ...agent } = request;
    const result = await this.plane.submit(
      {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: `${request.stepRunId}:${request.attemptId}`,
        agent,
        workspace: { projectId: request.projectId, ref: 'unused' },
        tools: [],
        limits: { timeoutMs: request.timeoutMs },
        networkPolicy: { mode: 'none', allowedHosts: [] },
        secrets: [],
      },
      signal,
    );
    if (result.state === 'cancelled') throw new RunCancelledError(request.runId);
    if (result.state === 'failed') throw new Error(result.error?.message ?? 'execution failed');
    return result.agent as AgentExecutionResult;
  }

  async health(): Promise<ExecutorHealth> {
    return { provider: 'mock', available: true, version: '1', message: 'test double' };
  }
}

export interface Stores {
  power: PowerSwitch;
  clock: Clock;
  projects: InMemoryProjects;
  runs: InMemoryRuns;
  stepRuns: InMemoryStepRuns;
  stepAttempts: InMemoryStepAttempts;
  modelOverrides: InMemoryModelOverrides;
  approvalRequests: InMemoryApprovalRequests;
  approvalDecisions: InMemoryApprovalDecisions;
  artifacts: InMemoryArtifacts;
  events: InMemoryEvents;
  workspaces: FakeWorkspaces;
  harnessVersion: { value: string };
}

export function makeStores(clock: Clock = new SystemClock()): Stores {
  const power: PowerSwitch = { on: true };
  return {
    power,
    clock,
    projects: new InMemoryProjects(power),
    runs: new InMemoryRuns(power),
    stepRuns: new InMemoryStepRuns(power),
    stepAttempts: new InMemoryStepAttempts(power),
    modelOverrides: new InMemoryModelOverrides(),
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
  opts: {
    fallback?: boolean;
    gate?: GateOptions;
    policy?: ProjectPolicy;
    models?: ModelDefinition[];
    workflow?: WorkflowDefinition;
    verification?: () => VerificationReport | Promise<VerificationReport>;
    browserVerification?: BrowserVerificationCoordinator;
    agentOutput?: (request: AgentExecutionRequest) => AgentExecutionResult['output'] | undefined;
  } = {},
) {
  const stores = existing ?? makeStores();
  const ids = new SequentialIds();
  const executor = new ControllableExecutor(behaviors, stores.workspaces, opts.agentOutput);
  const policies = new InMemoryPolicies(opts.policy ?? DEFAULT_POLICY);
  const models = opts.models ?? MODELS;
  // Fallback recovery needs the mutating step to offer a second candidate.
  // A gate opt inserts an approval-gate node reviewing the review artifact,
  // between 'review' and 'verify', for approval-gate.test.ts.
  const baseWorkflow = opts.workflow ?? WORKFLOW;
  const workflow: WorkflowDefinition = WorkflowDefinitionSchema.parse({
    ...baseWorkflow,
    nodes: [
      ...baseWorkflow.nodes.map((node) =>
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
    verify: async (input) => {
      verifierInputs.push(input);
      if (opts.verification) return opts.verification();
      return {
        schemaVersion: '1',
        approved: true,
        packageManager: 'npm',
        summary: 'ok',
        commands: [],
        createdAt: new Date().toISOString(),
      } satisfies VerificationReport;
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
    route: (profile, explicit) => {
      const selected = explicit ? models.find((model) => model.id === explicit.modelId) : models[0];
      if (!selected) return Promise.reject(new ExecutionError('Override model is not in catalog'));
      if (
        explicit &&
        (selected.provider !== explicit.provider || selected.model !== explicit.model)
      ) {
        return Promise.reject(new ExecutionError('Override model catalog tuple changed'));
      }
      return Promise.resolve(
        RouteDecisionSchema.parse({
          routeId: 'route-1',
          createdAt: new Date().toISOString(),
          profile,
          selected: {
            model: selected,
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
          fallbacks:
            !explicit && opts.fallback
              ? [
                  {
                    model: models[1]!,
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
          ...(explicit?.provenance ? { override: explicit.provenance } : {}),
          rejected: [],
        }),
      );
    },
    catalog: () => Promise.resolve(models),
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
  const enqueued: QueueJob[] = [];
  let enqueueFailure: Error | undefined;
  const queue: JobQueue = {
    enqueue: (job) => {
      if (enqueueFailure) {
        const failure = enqueueFailure;
        enqueueFailure = undefined;
        return Promise.reject(failure);
      }
      if (!enqueued.some((pending) => pending.id === job.id)) enqueued.push(job);
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
    executor,
    verifier,
    stores.workspaces,
    stores.clock,
    ids,
    { agentTimeoutMs: 60_000, cancelPollIntervalMs: 10 },
    stores.modelOverrides,
    undefined,
    opts.browserVerification,
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
    stores.modelOverrides,
  );
  return {
    ...stores,
    ids,
    executor,
    workflow,
    orchestrator,
    service,
    enqueued,
    failNextEnqueue(error: Error) {
      enqueueFailure = error;
    },
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
    workflowId: harness.workflow.id,
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
    workflowId: harness.workflow.id,
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
