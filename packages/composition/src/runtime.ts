import {
  MockAgentExecutor,
  MockExecutorRegistry,
  StaticExecutorRegistry,
  CodexCliExecutor,
  ClaudeCliExecutor,
  AgyCliExecutor,
  WorkspaceVerifier,
  PlaywrightBrowserVerifier,
  NodePreviewRunner,
  LocalExecutionPlane,
} from '@agent-foundry/executors';
import { VersionedHarnessRepository } from '@agent-foundry/harness';
import { ScoreBasedModelRouter, loadModelCatalog } from '@agent-foundry/model-router';
import {
  FileApprovalDecisionRepository,
  FileApprovalRequestRepository,
  FileArtifactStore,
  FileConversationRepository,
  FileEventStore,
  FileJobQueue,
  FileMetricsRepository,
  FileModelOverrideRepository,
  FileQualityObservationRepository,
  FileProjectRepository,
  FilePreviewLifecycleLock,
  FilePreviewLogRepository,
  FilePreviewSessionRepository,
  FileProjectVersionRepository,
  FileStepAttemptRepository,
  FileStepEventRepository,
  FileStepRunRepository,
  FileWorkflowRunRepository,
  FileWorkspaceManager,
  YamlPolicyRepository,
  YamlWorkflowRepository,
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
  QualityObservationService,
  BrowserVerificationCoordinator,
  type BrowserEvidenceLimits,
} from '@agent-foundry/orchestrator';
import { SystemClock, UlidGenerator } from '@agent-foundry/domain';
import type { BrowserVerifier } from '@agent-foundry/domain';
import { BrowserTestPlanArtifactSchema, type PreviewSession } from '@agent-foundry/contracts';
import { loadRuntimeConfig, type RuntimeConfig } from './config.js';

export interface Runtime {
  config: RuntimeConfig;
  projects: FileProjectRepository;
  runs: FileWorkflowRunRepository;
  stepRuns: FileStepRunRepository;
  stepAttempts: FileStepAttemptRepository;
  approvalRequests: FileApprovalRequestRepository;
  approvalDecisions: FileApprovalDecisionRepository;
  artifacts: FileArtifactStore;
  conversations: FileConversationRepository;
  events: FileEventStore;
  stepEvents: FileStepEventRepository;
  queue: FileJobQueue;
  metrics: FileMetricsRepository;
  qualityObservations: FileQualityObservationRepository;
  modelOverrides: FileModelOverrideRepository;
  workflows: YamlWorkflowRepository;
  policies: YamlPolicyRepository;
  harness: VersionedHarnessRepository;
  workspaces: FileWorkspaceManager;
  router: ScoreBasedModelRouter;
  executors: StaticExecutorRegistry | MockExecutorRegistry;
  executionPlane: LocalExecutionPlane;
  verifier: WorkspaceVerifier;
  browserVerifier: PlaywrightBrowserVerifier;
  browserVerification: BrowserVerificationCoordinator;
  projectService: ProjectService;
  conversationService: ConversationService;
  operationRunner: ConversationOperationRunner;
  operationService: OperationService;
  orchestrator: WorkflowOrchestrator;
  worker: WorkerLoop;
  leaseReaper: QueueLeaseReaper;
  previewRunner: NodePreviewRunner;
  previewSessions: FilePreviewSessionRepository;
  previewLogs: FilePreviewLogRepository;
  previewLifecycleLock: FilePreviewLifecycleLock;
  previewService: PreviewService;
  previewSelectionService: PreviewSelectionService;
  projectVersions: FileProjectVersionRepository;
  projectVersionService: ProjectVersionService;
}

export async function createRuntime(
  env: NodeJS.ProcessEnv = process.env,
  config: RuntimeConfig = loadRuntimeConfig(env),
): Promise<Runtime> {
  const clock = new SystemClock();
  const ids = new UlidGenerator();
  const projects = new FileProjectRepository(config.dataDir);
  const runs = new FileWorkflowRunRepository(config.dataDir);
  const stepRuns = new FileStepRunRepository(config.dataDir);
  const stepAttempts = new FileStepAttemptRepository(config.dataDir);
  const approvalRequests = new FileApprovalRequestRepository(config.dataDir);
  const approvalDecisions = new FileApprovalDecisionRepository(config.dataDir);
  const artifacts = new FileArtifactStore(config.dataDir);
  const conversations = new FileConversationRepository(config.dataDir);
  const events = new FileEventStore(config.dataDir);
  const stepEvents = new FileStepEventRepository(config.dataDir);
  const queue = new FileJobQueue(config.dataDir, { leaseMs: config.queueLeaseMs, clock });
  const metrics = new FileMetricsRepository(config.dataDir);
  const qualityObservations = new FileQualityObservationRepository(config.dataDir);
  const qualityObservationService = new QualityObservationService(qualityObservations, clock, ids);
  const modelOverrides = new FileModelOverrideRepository(config.dataDir);
  const workflows = new YamlWorkflowRepository(config.workflowsDir);
  const policies = new YamlPolicyRepository(config.policiesDir);
  const harness = new VersionedHarnessRepository(config.harnessDir);
  const workspaces = new FileWorkspaceManager(config.dataDir, {
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  });
  const catalog = await loadModelCatalog(config.modelCatalogPath, env);
  const router = new ScoreBasedModelRouter(catalog, metrics, qualityObservations);
  const executors =
    config.executorMode === 'mock'
      ? new MockExecutorRegistry(new MockAgentExecutor())
      : new StaticExecutorRegistry([
          new CodexCliExecutor(config.maxCliOutputBytes),
          new ClaudeCliExecutor(config.maxCliOutputBytes),
          new AgyCliExecutor(config.maxCliOutputBytes),
        ]);
  const executionPlane = new LocalExecutionPlane(executors, workspaces);
  const verifier = new WorkspaceVerifier({
    autoInstallDependencies: config.autoInstallDependencies,
    timeoutMs: config.verificationTimeoutMs,
    maxOutputBytes: config.maxCliOutputBytes,
  });
  const previewSessions = new FilePreviewSessionRepository(config.dataDir);
  const previewLogs = new FilePreviewLogRepository(config.dataDir, config.previewLogMaxBytes);
  const previewLifecycleLock = new FilePreviewLifecycleLock(config.dataDir);
  const previewRunner = new NodePreviewRunner({
    startupTimeoutMs: config.previewStartupTimeoutMs,
    maxOutputBytes: config.maxCliOutputBytes,
    healthPath: config.previewHealthPath,
    logRepository: previewLogs,
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
  const browserVerifier = new PlaywrightBrowserVerifier();
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
    { agentTimeoutMs: config.agentTimeoutMs, cancelPollIntervalMs: config.cancelPollIntervalMs },
    modelOverrides,
    projectVersionService,
    browserVerification,
    qualityObservationService,
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
    workflows,
    policies,
    harness,
    router,
    workspaces,
    clock,
    ids,
    modelOverrides,
    qualityObservationService,
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
  });
  const leaseReaper = new QueueLeaseReaper(queue, events, clock, ids, {
    intervalMs: config.queueReapIntervalMs,
  });

  return {
    config,
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
    queue,
    metrics,
    qualityObservations,
    modelOverrides,
    workflows,
    policies,
    harness,
    workspaces,
    router,
    executors,
    executionPlane,
    verifier,
    browserVerifier,
    browserVerification,
    projectService,
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
  };
}

function mockBrowserVerificationCoordinator(
  artifacts: Pick<FileArtifactStore, 'putBlob'>,
  limits: BrowserEvidenceLimits,
): BrowserVerificationCoordinator {
  let sequence = 0;
  const sessions = new Map<string, PreviewSession>();
  const previews: Pick<PreviewService, 'start' | 'stop'> = {
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
