import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  MockAgentExecutor,
  MockExecutorRegistry,
  StaticExecutorRegistry,
  CodexCliExecutor,
  ClaudeCliExecutor,
  WorkspaceVerifier,
  PlaywrightBrowserVerifier,
  NodePreviewRunner,
  LocalExecutionPlane,
  DockerSandboxRunner,
  DockerPreviewInstaller,
  type PreviewInstaller,
} from '@agent-foundry/executors';
import {
  VersionedHarnessRepository,
  VersionedSystemPromptRepository,
} from '@agent-foundry/harness';
import { TableModelRouter, loadModelCatalog } from '@agent-foundry/model-router';
import {
  FileApprovalDecisionRepository,
  FileApprovalRequestRepository,
  FileArtifactStore,
  FileConversationRepository,
  FileEventStore,
  FileExperimentRepository,
  FileJobQueue,
  FileKnowledgeFileRepository,
  FileMetricsRepository,
  FileModelOverrideRepository,
  FileQualityObservationRepository,
  FileRouterDecisionLogRepository,
  FileProjectRepository,
  FilePreviewLifecycleLock,
  FilePreviewLogRepository,
  FilePreviewSessionRepository,
  FileProjectVersionRepository,
  FileSecretStore,
  FileStepAttemptRepository,
  FileStepEventRepository,
  FileStepRunRepository,
  FileWorkflowRunRepository,
  FileWorkspaceManager,
  FsBlobStore,
  S3BlobStore,
  YamlPolicyRepository,
  YamlWorkflowRepository,
  assertSchemaCurrent,
  createPostgresClient,
  NoopTransactionRunner,
  PostgresApprovalDecisionRepository,
  PostgresApprovalRequestRepository,
  PostgresArtifactStore,
  PostgresConversationRepository,
  type PostgresDb,
  PostgresEventStore,
  PostgresJobQueue,
  PostgresProjectRepository,
  PostgresPreviewLifecycleLock,
  PostgresStepAttemptRepository,
  PostgresStepEventRepository,
  PostgresStepRunRepository,
  PostgresTransactionRunner,
  PostgresWorkflowRunRepository,
} from '@agent-foundry/persistence';
import {
  ConversationOperationRunner,
  ConversationService,
  OperationService,
  ProjectService,
  ProjectVersionService,
  QueueLeaseReaper,
  WorkerLoop,
  WorkflowOrchestrator,
  PreviewService,
  PreviewSelectionService,
  ValidationEvidenceService,
  QualityObservationService,
  BrowserVerificationCoordinator,
  type BrowserEvidenceLimits,
  type JobLogger,
} from '@agent-foundry/orchestrator';
import { SystemClock, UlidGenerator } from '@agent-foundry/domain';
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  BlobStore,
  BrowserVerifier,
  ConversationRepository,
  ExecutorRegistry,
  EventStore,
  JobQueue,
  ProjectRepository,
  PreviewLifecycleLock,
  StepAttemptRepository,
  StepEventRepository,
  StepRunRepository,
  TransactionRunner,
  WorkflowRunRepository,
  GeneratedProjectRuntime,
} from '@agent-foundry/domain';
import { SupabaseGeneratedProjectRuntime } from '@agent-foundry/platform';
import { buildValidationCampaignPreview } from '@agent-foundry/model-router';
import {
  BrowserTestPlanArtifactSchema,
  ValidationPreflightReportSchema,
  type ValidationPreflightReport,
  type ValidationCampaignPreview,
  type PreviewSession,
} from '@agent-foundry/contracts';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';
import {
  createProductionValidationPreflightChecks,
  persistValidationPreflightReport,
  readValidationPreflightReport,
  runValidationPreflight as runPreflight,
} from './validation-preflight.js';

const execFileAsync = promisify(execFile);

export interface Runtime {
  config: RuntimeConfig;
  validationCampaign?: ValidationCampaignPreview;
  runValidationPreflight?(): Promise<ValidationPreflightReport>;
  projects: ProjectRepository;
  runs: WorkflowRunRepository;
  stepRuns: StepRunRepository;
  stepAttempts: StepAttemptRepository;
  approvalRequests: ApprovalRequestRepository;
  approvalDecisions: ApprovalDecisionRepository;
  artifacts: ArtifactStore;
  blobStore: BlobStore;
  conversations: ConversationRepository;
  knowledgeFiles: FileKnowledgeFileRepository;
  events: EventStore;
  stepEvents: StepEventRepository;
  queue: JobQueue;
  metrics: FileMetricsRepository;
  qualityObservations: FileQualityObservationRepository;
  modelOverrides: FileModelOverrideRepository;
  decisionLog: FileRouterDecisionLogRepository;
  experiments: FileExperimentRepository;
  workflows: YamlWorkflowRepository;
  policies: YamlPolicyRepository;
  harness: VersionedHarnessRepository;
  systemPrompts: VersionedSystemPromptRepository;
  workspaces: FileWorkspaceManager;
  secretStore: FileSecretStore;
  router: TableModelRouter;
  executors: ExecutorRegistry;
  executionPlane: LocalExecutionPlane;
  verifier: WorkspaceVerifier;
  browserVerifier: PlaywrightBrowserVerifier;
  browserVerification: BrowserVerificationCoordinator;
  projectService: ProjectService;
  validationEvidence: ValidationEvidenceService;
  conversationService: ConversationService;
  operationRunner: ConversationOperationRunner;
  operationService: OperationService;
  orchestrator: WorkflowOrchestrator;
  worker: WorkerLoop;
  leaseReaper: QueueLeaseReaper;
  previewRunner: NodePreviewRunner;
  previewSessions: FilePreviewSessionRepository;
  previewLogs: FilePreviewLogRepository;
  previewLifecycleLock: PreviewLifecycleLock;
  previewService: PreviewService;
  previewSelectionService: PreviewSelectionService;
  projectVersions: FileProjectVersionRepository;
  projectVersionService: ProjectVersionService;
  generatedProjectRuntime?: GeneratedProjectRuntime;
  checkReadiness(): Promise<void>;
}

export interface RuntimeOverrides {
  /**
   * Replaces the production preview dependency installer for controlled tests.
   * `null` deliberately selects NodePreviewRunner's local installer; real-mode
   * production callers omit this override and always receive the Docker-backed
   * deny-by-default installer.
   */
  previewInstaller?: PreviewInstaller | null;
  /** Test-only escape hatch for real-mode suites that use controlled local fixtures. */
  generatedProjectRuntime?: GeneratedProjectRuntime | null;
  /** Test-only executor registry override for controlled validation runs. */
  executors?: ExecutorRegistry;
  /** Test-only switch to keep a controlled workflow away from preview boot. */
  disablePreviews?: boolean;
  /** Test-only preflight report source for public validation-runtime tests. */
  validationPreflight?: (campaign: ValidationCampaignPreview) => Promise<ValidationPreflightReport>;
}

export async function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
  config: RuntimeConfig = loadRuntimeConfig(env),
  /** Per-job child logger for the worker loop (e.g. a pino instance); apps/worker wires this in. Omit for a silent worker (composition stays free of a pino dependency). */
  workerLogger?: JobLogger,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  const clock = new SystemClock();
  const ids = new UlidGenerator();
  const blobStore: BlobStore =
    config.blobStoreMode === 's3'
      ? new S3BlobStore({
          // superRefine in config.ts guarantees these are set whenever mode is 's3'.
          ...(config.s3Endpoint !== undefined ? { endpoint: config.s3Endpoint } : {}),
          region: config.s3Region!,
          bucket: config.s3Bucket!,
          accessKeyId: config.s3AccessKeyId!,
          secretAccessKey: config.s3SecretAccessKey!,
          forcePathStyle: config.s3ForcePathStyle,
        })
      : new FsBlobStore(config.dataDir, {
          // fs mode always derives or reads blobSigningSecret in config.ts.
          signingSecret: config.blobSigningSecret!,
          publicBaseUrl: `http://${config.apiHost}:${config.apiPort}`,
        });
  const {
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    conversations,
    events,
    stepEvents,
    sql,
    transactionRunner,
  } = await createMetadataStores(config, blobStore);
  const checkReadiness = async (): Promise<void> => {
    if (sql) await sql`select 1`;
  };
  const knowledgeFiles = new FileKnowledgeFileRepository(config.dataDir);
  const queue: JobQueue =
    config.persistenceMode === 'postgres'
      ? new PostgresJobQueue(sql!, { leaseMs: config.queueLeaseMs, clock })
      : new FileJobQueue(config.dataDir, { leaseMs: config.queueLeaseMs, clock });
  const metrics = new FileMetricsRepository(config.dataDir);
  const qualityObservations = new FileQualityObservationRepository(config.dataDir);
  const qualityObservationService = new QualityObservationService(qualityObservations, clock, ids);
  const modelOverrides = new FileModelOverrideRepository(config.dataDir);
  const decisionLog = new FileRouterDecisionLogRepository(config.dataDir);
  const experiments = new FileExperimentRepository(config.dataDir);
  const workflows = new YamlWorkflowRepository(config.workflowsDir);
  const policies = new YamlPolicyRepository(config.policiesDir);
  const harness = new VersionedHarnessRepository(config.harnessDir);
  const systemPrompts = new VersionedSystemPromptRepository(
    join(config.harnessDir, 'system-prompts'),
  );
  const workspaces = new FileWorkspaceManager(config.dataDir, {
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  });
  const secretStore = new FileSecretStore(workspaces);
  let generatedProjectRuntime: GeneratedProjectRuntime | undefined;
  if (config.executorMode === 'real' && overrides.generatedProjectRuntime !== null) {
    generatedProjectRuntime =
      overrides.generatedProjectRuntime ??
      new SupabaseGeneratedProjectRuntime({
        dataDir: config.dataDir,
        initializeTimeoutMs: config.supabaseProvisioningTimeoutMs,
      });
  }
  const catalog = await loadModelCatalog(config.modelCatalogPath, env);
  const sourceRevision = config.validationCampaignId
    ? await readSourceRevision(config.rootDir)
    : undefined;
  const validationCampaign =
    sourceRevision !== undefined
      ? buildValidationCampaignPreview(catalog, sourceRevision, env)
      : undefined;
  const readCurrentValidationPreflight =
    validationCampaign && sourceRevision
      ? () => readValidationPreflightReport(config.dataDir, sourceRevision)
      : undefined;
  const validationEvidence = new ValidationEvidenceService(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    async (runId) => {
      const run = await runs.get(runId);
      if (!run) return undefined;
      const metadata = (await artifacts.listMetadata(run.projectId, 'validation-preflight'))
        .filter((item) => item.runId === runId)
        .at(-1);
      if (!metadata) return undefined;
      const artifact = await artifacts.getRevision(run.projectId, metadata.name, metadata.revision);
      if (!artifact) return undefined;
      const parsed = ValidationPreflightReportSchema.safeParse(artifact.content);
      return parsed.success ? parsed.data : undefined;
    },
  );
  // TableModelRouter keeps its default circuit breaker configuration. A selected
  // validation campaign is passed as run-scoped state; it must not replace the
  // process-wide product router for normal runs.
  const router = new TableModelRouter(catalog, metrics);
  const executors =
    overrides.executors ??
    (config.executorMode === 'mock'
      ? new MockExecutorRegistry(new MockAgentExecutor())
      : new StaticExecutorRegistry([
          // A selected campaign enforces executed-model identity on every
          // dispatch; without reportConfiguredModel the Codex CLI never
          // reveals it and the check burns a real attempt to learn that (#424).
          new CodexCliExecutor(config.maxCliOutputBytes, Boolean(config.validationCampaignId)),
          new ClaudeCliExecutor(config.maxCliOutputBytes, config.dataDir),
        ]));
  const executionPlane = new LocalExecutionPlane(executors, workspaces);
  const verifier = new WorkspaceVerifier({
    autoInstallDependencies: config.autoInstallDependencies,
    timeoutMs: config.verificationTimeoutMs,
    maxOutputBytes: config.maxCliOutputBytes,
  });
  const previewSessions = new FilePreviewSessionRepository(config.dataDir);
  const previewLogs = new FilePreviewLogRepository(config.dataDir, config.previewLogMaxBytes);
  const previewLifecycleLock: PreviewLifecycleLock = sql
    ? new PostgresPreviewLifecycleLock(sql)
    : new FilePreviewLifecycleLock(config.dataDir);
  const previewRunner = new NodePreviewRunner({
    startupTimeoutMs: config.previewStartupTimeoutMs,
    maxOutputBytes: config.maxCliOutputBytes,
    healthPath: config.previewHealthPath,
    logRepository: previewLogs,
    secretStore,
    ...(config.executorMode === 'real' && overrides.previewInstaller !== null
      ? {
          installer:
            overrides.previewInstaller ??
            new DockerPreviewInstaller({ runner: new DockerSandboxRunner() }),
        }
      : {}),
  });
  const previewService = new PreviewService(
    previewRunner,
    previewSessions,
    previewLifecycleLock,
    artifacts,
    events,
    clock,
    ids,
    {
      previewBaseUrl: `http://${config.apiHost}:${config.apiPort}/preview`,
      ttlSeconds: config.previewTtlSeconds,
      startupTimeoutMs: config.previewStartupTimeoutMs,
      healthIntervalMs: config.previewHealthIntervalMs,
      healthFailureThreshold: config.previewHealthFailureThreshold,
      maxRestarts: config.previewMaxRestarts,
    },
  );
  const projectVersions = new FileProjectVersionRepository(config.dataDir);
  const projectVersionService = new ProjectVersionService(
    projectVersions,
    workspaces,
    artifacts,
    clock,
    ids,
  );
  const browserVerifier = new PlaywrightBrowserVerifier({
    allowLocalRedirects: config.allowLocalBrowserRedirects,
  });
  const previewSelectionService = new PreviewSelectionService(
    workspaces,
    browserVerifier,
    `http://${config.apiHost}:${config.apiPort}/preview`,
  );
  const browserEvidenceLimits = {
    maxScreenshotBytes: config.artifactMaxScreenshotBytes,
    maxTraceBytes: config.artifactMaxTraceBytes,
    maxVideoBytes: config.artifactMaxVideoBytes,
    retentionSeconds: config.artifactRetentionSeconds,
  };
  const browserVerification =
    config.executorMode === 'mock'
      ? mockBrowserVerificationCoordinator(artifacts, browserEvidenceLimits)
      : new BrowserVerificationCoordinator(
          previewService,
          browserVerifier,
          artifacts,
          browserEvidenceLimits,
        );
  const orchestrator = new WorkflowOrchestrator(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    queue,
    artifacts,
    events,
    stepEvents,
    workflows,
    policies,
    harness,
    router,
    metrics,
    executionPlane,
    verifier,
    workspaces,
    clock,
    ids,
    {
      agentTimeoutMs: config.agentTimeoutMs,
      cancelPollIntervalMs: config.cancelPollIntervalMs,
      maxParallelTasks: config.maxParallelTasks,
    },
    modelOverrides,
    projectVersionService,
    browserVerification,
    qualityObservationService,
    executors,
    secretStore,
    decisionLog,
    generatedProjectRuntime,
    // Provisioning boots the scaffolded workspace only in real mode; the mock
    // executor never installs anything (#318).
    config.executorMode === 'real' && !overrides.disablePreviews ? previewService : undefined,
    validationCampaign,
    validationCampaign ? validationEvidence : undefined,
    systemPrompts,
  );
  const projectService = new ProjectService(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    events,
    queue,
    transactionRunner,
    workflows,
    policies,
    harness,
    router,
    workspaces,
    clock,
    ids,
    modelOverrides,
    qualityObservationService,
    validationCampaign,
    readCurrentValidationPreflight,
  );
  const conversationService = new ConversationService(
    projects,
    runs,
    artifacts,
    conversations,
    clock,
    ids,
  );
  const operationRunner = new ConversationOperationRunner(
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
    knowledgeFiles,
    projectVersionService,
    clock,
    ids,
    { agentTimeoutMs: config.agentTimeoutMs, verifier, browserVerification },
  );
  const operationService = new OperationService(
    conversations,
    runs,
    queue,
    artifacts,
    clock,
    ids,
    conversationService,
    workspaces,
  );
  const worker = new WorkerLoop(queue, orchestrator, operationRunner, {
    workerId: config.workerId,
    pollIntervalMs: config.workerPollIntervalMs,
    heartbeatIntervalMs: config.queueHeartbeatIntervalMs,
    ...(workerLogger ? { logger: workerLogger } : {}),
  });
  const leaseReaper = new QueueLeaseReaper(queue, events, clock, ids, {
    intervalMs: config.queueReapIntervalMs,
  });
  const validationPreflight = overrides.validationPreflight;
  const runValidationCampaignPreflight =
    validationCampaign && sourceRevision
      ? validationPreflight
        ? async (): Promise<ValidationPreflightReport> => {
            const report = await validationPreflight(validationCampaign);
            await persistValidationPreflightReport(config.dataDir, report);
            return report;
          }
        : async (): Promise<ValidationPreflightReport> => {
            const environmentId = `validation-preflight-${ids.next()}`;
            return runPreflight({
              campaign: validationCampaign,
              sourceRevision,
              rootDirectory: config.rootDir,
              dataDirectory: config.dataDir,
              executorMode: config.executorMode,
              environmentId,
              checks: createProductionValidationPreflightChecks({
                campaign: validationCampaign,
                environmentId,
                harness,
                workspaces,
                ...(generatedProjectRuntime ? { generatedProjectRuntime } : {}),
                previews: previewService,
                previewRunner,
                maxOutputBytes: config.maxCliOutputBytes,
                installTimeoutMs: config.verificationTimeoutMs,
              }),
              persist: (report) => persistValidationPreflightReport(config.dataDir, report),
            });
          }
      : undefined;

  return {
    config,
    ...(validationCampaign ? { validationCampaign } : {}),
    ...(runValidationCampaignPreflight
      ? { runValidationPreflight: runValidationCampaignPreflight }
      : {}),
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    artifacts,
    blobStore,
    conversations,
    knowledgeFiles,
    events,
    stepEvents,
    queue,
    metrics,
    qualityObservations,
    modelOverrides,
    decisionLog,
    experiments,
    workflows,
    policies,
    harness,
    systemPrompts,
    workspaces,
    secretStore,
    router,
    executors,
    executionPlane,
    verifier,
    browserVerifier,
    browserVerification,
    projectService,
    validationEvidence,
    conversationService,
    operationRunner,
    operationService,
    orchestrator,
    worker,
    leaseReaper,
    previewRunner,
    previewSessions,
    previewLogs,
    previewLifecycleLock,
    previewService,
    previewSelectionService,
    projectVersions,
    projectVersionService,
    checkReadiness,
    ...(generatedProjectRuntime ? { generatedProjectRuntime } : {}),
  };
}

async function readSourceRevision(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootDir });
    const revision = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      throw new Error(`git rev-parse HEAD returned an invalid revision: ${revision || '<empty>'}`);
    }
    return revision;
  } catch (cause) {
    throw new Error('Validation campaign requires a readable Git source revision', { cause });
  }
}

/** Metadata stores (and, since issue #55, the queue and transaction seam) swap between file and
 * Postgres backends by PERSISTENCE_MODE; everything else (metrics, quality, previews, model
 * overrides, project versions, workflows, policies, workspaces) stays file-based regardless. */
async function createMetadataStores(
  config: RuntimeConfig,
  blobStore: BlobStore,
): Promise<{
  projects: ProjectRepository;
  runs: WorkflowRunRepository;
  stepRuns: StepRunRepository;
  stepAttempts: StepAttemptRepository;
  approvalRequests: ApprovalRequestRepository;
  approvalDecisions: ApprovalDecisionRepository;
  artifacts: ArtifactStore;
  conversations: ConversationRepository;
  events: EventStore;
  stepEvents: StepEventRepository;
  sql?: PostgresDb;
  transactionRunner: TransactionRunner;
}> {
  if (config.persistenceMode === 'file') {
    return {
      projects: new FileProjectRepository(config.dataDir),
      runs: new FileWorkflowRunRepository(config.dataDir),
      stepRuns: new FileStepRunRepository(config.dataDir),
      stepAttempts: new FileStepAttemptRepository(config.dataDir),
      approvalRequests: new FileApprovalRequestRepository(config.dataDir),
      approvalDecisions: new FileApprovalDecisionRepository(config.dataDir),
      artifacts: new FileArtifactStore(config.dataDir, blobStore),
      conversations: new FileConversationRepository(config.dataDir),
      events: new FileEventStore(config.dataDir),
      stepEvents: new FileStepEventRepository(config.dataDir),
      transactionRunner: new NoopTransactionRunner(),
    };
  }
  // loadRuntimeConfig already enforces DATABASE_URL when PERSISTENCE_MODE=postgres; this guards
  // a RuntimeConfig built by hand (e.g. directly in a test) bypassing that check.
  if (!config.databaseUrl) {
    throw new Error('PERSISTENCE_MODE=postgres requires DATABASE_URL');
  }
  const sql = createPostgresClient(config.databaseUrl);
  await assertSchemaCurrent(sql);
  return {
    projects: new PostgresProjectRepository(sql),
    runs: new PostgresWorkflowRunRepository(sql),
    stepRuns: new PostgresStepRunRepository(sql),
    stepAttempts: new PostgresStepAttemptRepository(sql),
    approvalRequests: new PostgresApprovalRequestRepository(sql),
    approvalDecisions: new PostgresApprovalDecisionRepository(sql),
    artifacts: new PostgresArtifactStore(sql),
    conversations: new PostgresConversationRepository(sql),
    events: new PostgresEventStore(sql),
    stepEvents: new PostgresStepEventRepository(sql),
    sql,
    transactionRunner: new PostgresTransactionRunner(sql),
  };
}

function mockBrowserVerificationCoordinator(
  artifacts: Pick<ArtifactStore, 'putBlob'>,
  limits: BrowserEvidenceLimits,
): BrowserVerificationCoordinator {
  let sequence = 0;
  const sessions = new Map<string, PreviewSession>();
  const previews: Pick<PreviewService, 'activeForProject' | 'start' | 'stop'> = {
    activeForProject: () => Promise.resolve(undefined),
    start: (input) => {
      sequence += 1;
      const now = new Date().toISOString();
      const id = `mock-preview-${sequence}`;
      const session: PreviewSession = {
        id,
        ...(input.runId ? { runId: input.runId } : {}),
        workspaceRef: input.workspaceRef,
        status: 'running',
        version: 1,
        url: `http://127.0.0.1/preview/${id}/?token=mock`,
        process: { command: 'mock-preview', args: [], port: 80 },
        health: { state: 'healthy', checkedAt: now, consecutiveFailures: 0 },
        ttl: { seconds: 1800, expiresAt: new Date(Date.now() + 1_800_000).toISOString() },
        restartCount: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };
      sessions.set(id, session);
      return Promise.resolve({ session, url: session.url! });
    },
    stop: (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) return Promise.reject(new Error(`Unknown mock preview ${sessionId}`));
      const now = new Date().toISOString();
      return Promise.resolve({
        ...session,
        status: 'stopped',
        updatedAt: now,
        completedAt: now,
      });
    },
  };
  const verifier: BrowserVerifier = {
    verify: (input) => {
      const plan = BrowserTestPlanArtifactSchema.parse(input.planContent).data;
      return Promise.resolve({
        report: {
          schemaVersion: '1',
          approved: true,
          summary: 'Mock browser verification passed.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: plan.steps.map((step) => ({
            stepId: step.id,
            title: step.title,
            status: 'passed' as const,
            durationMs: 0,
            observations: [],
          })),
        },
        evidence: {
          screenshots: plan.steps.map((step) => ({
            stepId: step.id,
            url: input.session.url ?? 'http://127.0.0.1/',
            viewport: plan.viewport,
            buffer: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2p8lWQAAAABJRU5ErkJggg==',
              'base64',
            ),
          })),
        },
      });
    },
  };
  return new BrowserVerificationCoordinator(previews, verifier, artifacts, limits);
}
