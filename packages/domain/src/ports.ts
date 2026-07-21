import type { Readable } from 'node:stream';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentRole,
  AgentStreamEvent,
  AgentStreamEventInput,
  ApprovalDecision,
  ApprovalRequest,
  Attachment,
  ArtifactMetadata,
  ChangeRequest,
  Conversation,
  ArtifactReference,
  BrowserEvidencePolicy,
  BrowserVerificationReport,
  ExecutionRequest,
  ExecutionResult,
  ExecutionState,
  ExecutorHealth,
  ExecutorStreamEvent,
  ModelDefinition,
  ModelMetric,
  ModelOverrideRecord,
  Message,
  Operation,
  PreviewHealth,
  PreviewLogEntry,
  PreviewLogPage,
  PreviewSession,
  PreviewSessionReference,
  Project,
  ProjectPolicy,
  ProjectEvent,
  ProjectVersion,
  QualityObservation,
  QualityObservationQuery,
  QueueJob,
  RouteDecision,
  RouteOverrideProvenance,
  StoredArtifact,
  StepAttempt,
  StepRun,
  TaskCategory,
  TaskKind,
  TaskProfile,
  TaskTaxonomyVersion,
  VerificationReport,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';

export interface ProjectRepository {
  create(project: Project): Promise<void>;
  get(projectId: string): Promise<Project | null>;
  update(project: Project, expectedVersion: number): Promise<Project>;
  list(limit?: number): Promise<Project[]>;
  /** Every project, unpaged — for sweeps (e.g. blob GC) that must see the whole set. */
  listAll(): Promise<Project[]>;
}

export interface ConversationRepository {
  createConversation(conversation: Conversation): Promise<void>;
  getConversation(projectId: string): Promise<Conversation | null>;
  getSnapshot(projectId: string): Promise<ConversationSnapshot>;
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message>;
  listMessages(
    projectId: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<Message[]>;
  createAttachment(attachment: Attachment): Promise<Attachment>;
  getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null>;
  listAttachments(projectId: string): Promise<Attachment[]>;
  createOperation(operation: Operation): Promise<Operation>;
  getOperation(projectId: string, operationId: string): Promise<Operation | null>;
  updateOperation(operation: Operation): Promise<Operation>;
  listOperations(projectId: string): Promise<Operation[]>;
  createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest>;
  getChangeRequest(projectId: string, changeRequestId: string): Promise<ChangeRequest | null>;
  updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest>;
  listChangeRequests(projectId: string): Promise<ChangeRequest[]>;
}

export interface ConversationSnapshot {
  conversation: Conversation | null;
  messages: Message[];
  attachments: Attachment[];
  operations: Operation[];
  changeRequests: ChangeRequest[];
}

export interface WorkflowRunRepository {
  create(run: WorkflowRun): Promise<void>;
  get(runId: string): Promise<WorkflowRun | null>;
  list(projectId: string, limit?: number): Promise<WorkflowRun[]>;
  update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun>;
}

export interface StepRunRepository {
  create(step: StepRun): Promise<void>;
  get(runId: string, stepRunId: string): Promise<StepRun | null>;
  list(runId: string): Promise<StepRun[]>;
  update(step: StepRun, expectedVersion: number): Promise<StepRun>;
}

export interface StepAttemptRepository {
  create(attempt: StepAttempt): Promise<void>;
  get(runId: string, stepRunId: string, attemptId: string): Promise<StepAttempt | null>;
  list(runId: string, stepRunId: string): Promise<StepAttempt[]>;
  update(attempt: StepAttempt, expectedVersion: number): Promise<StepAttempt>;
}

/** Create-only audited model pins, ordered newest first. */
export interface ModelOverrideRepository {
  create(override: Omit<ModelOverrideRecord, 'sequence'>): Promise<ModelOverrideRecord>;
  list(runId: string): Promise<ModelOverrideRecord[]>;
}

/** Create-only: neither ApprovalRequest nor ApprovalDecision is ever updated. */
export interface ApprovalRequestRepository {
  create(request: ApprovalRequest): Promise<void>;
  get(runId: string, requestId: string): Promise<ApprovalRequest | null>;
  getForStepRun(runId: string, stepRunId: string): Promise<ApprovalRequest | null>;
  list(runId: string): Promise<ApprovalRequest[]>;
}

export interface ApprovalDecisionRepository {
  create(decision: ApprovalDecision): Promise<void>;
  get(runId: string, requestId: string): Promise<ApprovalDecision | null>;
}

export interface ArtifactBlobPutInput {
  projectId: string;
  name: string;
  contentType: string;
  createdBy: string;
  maxBytes: number;
  runId?: string;
  stepRunId?: string;
  attemptId?: string;
  retentionSeconds?: number;
}

export interface ArtifactStore {
  put(input: {
    projectId: string;
    name: string;
    content: unknown;
    contentType?: string;
    createdBy: string;
    runId?: string;
    stepRunId?: string;
    attemptId?: string;
    kind?: 'feedback';
    actor?: import('@agent-foundry/contracts').ActorRef;
    sourceDecisionId?: string;
    routeDecision?: RouteDecision;
    idempotencyKey?: string;
  }): Promise<StoredArtifact>;
  putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata>;
  getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null>;
  getLatest(projectId: string, name: string): Promise<StoredArtifact | null>;
  getRevision(projectId: string, name: string, revision: number): Promise<StoredArtifact | null>;
  listLatest(projectId: string): Promise<StoredArtifact[]>;
  listMetadata(projectId: string, name?: string): Promise<ArtifactMetadata[]>;
  /** Marks expired blob artifacts deleted (metadata survives); returns the count reaped. */
  reapExpired(now: Date): Promise<number>;
}

export interface EventStore {
  append(event: ProjectEvent): Promise<void>;
  list(projectId: string, limit?: number, afterId?: string): Promise<ProjectEvent[]>;
}

export interface StepEventRepository {
  append(event: AgentStreamEventInput): Promise<AgentStreamEvent>;
  list(runId: string, options?: { cursor?: number; limit?: number }): Promise<AgentStreamEvent[]>;
}

/**
 * Claim grants a lease with a monotonic fencingToken. heartbeat, ack, and nack
 * all validate that token against the on-disk lease and throw LeaseLostError
 * when it is stale — reclaimed by reapExpired or claimed by another worker.
 */
export interface JobQueue {
  enqueue(job: QueueJob): Promise<void>;
  claim(workerId: string): Promise<QueueJob | null>;
  heartbeat(job: QueueJob, workerId: string): Promise<QueueJob>;
  ack(job: QueueJob, workerId: string): Promise<void>;
  nack(job: QueueJob, workerId: string, error: Error): Promise<void>;
  reapExpired(): Promise<QueueJob[]>;
}

export interface WorkflowRepository {
  get(workflowId: string): Promise<WorkflowDefinition>;
  list(): Promise<WorkflowDefinition[]>;
}

export interface PolicyRepository {
  get(policyId: string): Promise<ProjectPolicy>;
}

export interface HarnessSelection {
  version: string;
  files: Array<{
    path: string;
    content: string;
    priority: number;
  }>;
  combined: string;
}

export interface HarnessRepository {
  select(input: {
    role: AgentRole;
    taskKind: TaskKind;
    stack: string;
    tags: string[];
  }): Promise<HarnessSelection>;
  version(): Promise<string>;
}

export interface ExplicitModelRoute {
  modelId: string;
  provider: ModelDefinition['provider'];
  model: string;
  provenance?: RouteOverrideProvenance;
}

export interface RouteConstraints {
  /** Provider health keyed by provider id (e.g. 'claude'); rate-limited providers are excluded. */
  providerHealth?: ReadonlyMap<string, ExecutorHealth>;
  /** Remaining budget by unit. metered→maxCostUsd, subscription→maxQuotaUnits. */
  budget?: { maxCostUsd?: number; maxQuotaUnits?: number };
}

export interface ModelRouter {
  route(
    profile: TaskProfile,
    explicit?: ExplicitModelRoute,
    constraints?: RouteConstraints,
  ): Promise<RouteDecision>;
  catalog(): Promise<ModelDefinition[]>;
}

export interface MetricsRepository {
  get(
    modelId: string,
    taskKind: TaskKind,
    role: AgentRole,
    category?: TaskCategory,
  ): Promise<ModelMetric | null>;
  record(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    taxonomyVersion?: TaskTaxonomyVersion;
    category?: TaskCategory;
    success: boolean;
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    quotaUnits?: number;
    estimatedCostUsd?: number;
  }): Promise<void>;
  recordQuality(input: {
    modelId: string;
    taskKind: TaskKind;
    role: AgentRole;
    taxonomyVersion?: TaskTaxonomyVersion;
    category?: TaskCategory;
    approved: boolean;
  }): Promise<void>;
}

export interface QualityObservationRepository {
  record(observation: QualityObservation): Promise<void>;
  list(query: QualityObservationQuery): Promise<QualityObservation[]>;
}

export interface AgentExecutor {
  readonly provider: string;
  execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult>;
  health(): Promise<ExecutorHealth>;
}

export interface ExecutorRegistry {
  get(provider: string): AgentExecutor;
  health(): Promise<ExecutorHealth[]>;
}

export interface ExecutionStatus {
  executionId: string;
  state: 'pending' | 'running' | ExecutionState;
  result?: ExecutionResult;
}

/**
 * Boundary between the control plane (orchestrator) and wherever agent CLIs
 * actually run. `submit` always resolves — even a failed or cancelled run is
 * a normal response, not a rejection; only a genuine transport failure (the
 * call itself never completed) should reject. `cancel`/`status` are the
 * explicit, out-of-band remote-observability surface: a real remote
 * implementation is expected to also wire the AbortSignal passed to `submit`
 * into its own transport-level cancel, so callers keep this single
 * call-and-await shape.
 */
export interface ExecutionPlane {
  submit(
    request: ExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<ExecutionStatus>;
}

/**
 * Mechanism boundary for previews. The orchestrator owns PreviewSession state;
 * a runner only installs, serves, probes, and terminates one workspace preview.
 * Every method returns the updated session; stop must be idempotent so
 * cancellation and TTL expiry can always invoke it.
 */
export interface PreviewRunner {
  prepare(session: PreviewSession): Promise<PreviewSession>;
  start(session: PreviewSession): Promise<PreviewSession>;
  health(session: PreviewSession): Promise<PreviewHealth>;
  logs(
    session: PreviewSession,
    options?: { cursor?: number; limit?: number },
  ): Promise<PreviewLogPage>;
  restart(session: PreviewSession): Promise<PreviewSession>;
  stop(session: PreviewSession): Promise<PreviewSession>;
}

export interface CapturedScreenshot {
  stepId: string;
  url: string;
  viewport: { width: number; height: number };
  buffer: Buffer;
}

export interface BrowserVerificationEvidence {
  screenshots: CapturedScreenshot[];
  trace?: Buffer;
  video?: Buffer;
}

export interface BrowserVerifier {
  verify(
    input: {
      planArtifact: ArtifactReference;
      planContent: unknown;
      session: PreviewSessionReference;
      allowedOrigins: string[];
      evidencePolicy: BrowserEvidencePolicy;
    },
    signal: AbortSignal,
  ): Promise<{ report: BrowserVerificationReport; evidence: BrowserVerificationEvidence }>;
}

/**
 * On-demand, single-shot screenshot capture against a live preview session —
 * separate from BrowserVerifier's scheduled verify() flow, which requires a
 * full BrowserTestPlan/allowedOrigins/evidencePolicy. Used only for the
 * "unsupported selection" fallback (packages/orchestrator/src/preview-selection-service.ts).
 */
export interface SelectionScreenshotCapturer {
  captureSelectionScreenshot(input: {
    url: string;
    clip: { x: number; y: number; width: number; height: number };
    viewport: { width: number; height: number };
  }): Promise<Buffer | null>;
}

export interface PreviewSessionRecord {
  session: PreviewSession;
  tokenDigest: string;
}

export interface PreviewSessionRepository {
  create(record: PreviewSessionRecord): Promise<void>;
  get(sessionId: string): Promise<PreviewSessionRecord | null>;
  listActive(): Promise<PreviewSessionRecord[]>;
  update(session: PreviewSession, expectedVersion: number): Promise<PreviewSession>;
}

export interface PreviewLifecycleLock {
  withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}

export interface PreviewLogRepository {
  append(sessionId: string, entry: Omit<PreviewLogEntry, 'cursor'>): Promise<PreviewLogEntry>;
  list(sessionId: string, options?: { cursor?: number; limit?: number }): Promise<PreviewLogPage>;
}

export interface VerificationService {
  verify(
    input: {
      workspacePath: string;
      scripts: string[];
      includeGitDiffCheck: boolean;
      policy?: ProjectPolicy | undefined;
    },
    signal?: AbortSignal,
  ): Promise<VerificationReport>;
}

export interface WorkspaceManager {
  projectRoot(projectId: string): string;
  workspacePath(projectId: string): string;
  ensure(projectId: string): Promise<void>;
  writePrd(projectId: string, prd: string): Promise<void>;
  writeRunContext(input: {
    projectId: string;
    runId: string;
    stepRunId: string;
    attemptId: string;
    requestMarkdown: string;
    outputSchema: Record<string, unknown>;
  }): Promise<{ requestPath: string; schemaPath: string }>;
  ensureGit(projectId: string): Promise<void>;
  isClean(projectId: string): Promise<boolean>;
  checkpoint(projectId: string, label: string): Promise<string>;
  rollback(projectId: string, ref: string): Promise<void>;
  preserveDraft(
    projectId: string,
    runId: string,
    verifiedCheckpoint: string,
  ): Promise<{ draftBranch: string; draftCommit: string; created: boolean }>;
  discardDraft(projectId: string, runId: string, expectedCommit: string): Promise<void>;
  commit(projectId: string, message: string): Promise<string | null>;
  head(projectId: string): Promise<string | null>;
  /** Unified diff between two commits/refs, for comparing two ProjectVersions. */
  diff(projectId: string, fromRef: string, toRef: string): Promise<string>;
  /**
   * Checks out ref's tree onto the working copy without moving HEAD or
   * creating a commit; the caller commits explicitly (e.g. via `commit`) so
   * a revert always adds a new commit instead of rewriting history.
   */
  restoreTree(projectId: string, ref: string): Promise<void>;
  /** Creates a new branch at ref, independent of the current branch's HEAD. Returns ref's commit sha. */
  createBranch(projectId: string, ref: string, name: string): Promise<string>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

/** Append-only ledger once promoted; failed promotion may discard its exact, still-unpromoted write. */
export interface ProjectVersionRepository {
  create(version: ProjectVersion): Promise<void>;
  discardUnpromoted(version: ProjectVersion): Promise<void>;
  get(projectId: string, versionId: string): Promise<ProjectVersion | null>;
  list(projectId: string, limit?: number): Promise<ProjectVersion[]>;
  /** Only the `protected` flag is ever updated after creation. */
  update(version: ProjectVersion, expectedVersion: number): Promise<ProjectVersion>;
}

export interface BlobStat {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string; // ISO datetime
  encryption?: { algorithm: string };
}

export interface BlobPutInput {
  key: string;
  contentType: string;
  maxBytes: number;
  /** When provided, the store must verify the streamed content hashes to this value and fail otherwise. */
  expectedSha256?: string;
}

/** A blob key with its creation time — returned by BlobStore.list(), used by GC. */
export type BlobListEntry = { key: string; createdAt: string };

export interface BlobStore {
  put(input: BlobPutInput, source: Readable): Promise<BlobStat>;
  getStream(key: string): Promise<Readable | null>;
  stat(key: string): Promise<BlobStat | null>;
  delete(key: string): Promise<void>;
  /** All keys under a prefix, with creation time — used by GC. */
  list(prefix: string): Promise<BlobListEntry[]>;
  createSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
