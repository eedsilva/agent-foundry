import {
  MockAgentExecutor,
  MockExecutorRegistry,
  StaticExecutorRegistry,
  CodexCliExecutor,
  ClaudeCliExecutor,
  AgyCliExecutor,
  WorkspaceVerifier,
  NodePreviewRunner,
} from '@agent-foundry/executors';
import { VersionedHarnessRepository } from '@agent-foundry/harness';
import { ScoreBasedModelRouter, loadModelCatalog } from '@agent-foundry/model-router';
import {
  FileApprovalDecisionRepository,
  FileApprovalRequestRepository,
  FileArtifactStore,
  FileEventStore,
  FileJobQueue,
  FileMetricsRepository,
  FileModelOverrideRepository,
  FileProjectRepository,
  FilePreviewLifecycleLock,
  FilePreviewLogRepository,
  FilePreviewSessionRepository,
  FileStepAttemptRepository,
  FileStepRunRepository,
  FileWorkflowRunRepository,
  FileWorkspaceManager,
  YamlPolicyRepository,
  YamlWorkflowRepository,
} from '@agent-foundry/persistence';
import {
  ProjectService,
  QueueLeaseReaper,
  WorkerLoop,
  WorkflowOrchestrator,
  PreviewService,
} from '@agent-foundry/orchestrator';
import { SystemClock, UlidGenerator } from '@agent-foundry/domain';
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
  events: FileEventStore;
  queue: FileJobQueue;
  metrics: FileMetricsRepository;
  modelOverrides: FileModelOverrideRepository;
  workflows: YamlWorkflowRepository;
  policies: YamlPolicyRepository;
  harness: VersionedHarnessRepository;
  workspaces: FileWorkspaceManager;
  router: ScoreBasedModelRouter;
  executors: StaticExecutorRegistry | MockExecutorRegistry;
  verifier: WorkspaceVerifier;
  projectService: ProjectService;
  orchestrator: WorkflowOrchestrator;
  worker: WorkerLoop;
  leaseReaper: QueueLeaseReaper;
  previewRunner: NodePreviewRunner;
  previewSessions: FilePreviewSessionRepository;
  previewLogs: FilePreviewLogRepository;
  previewLifecycleLock: FilePreviewLifecycleLock;
  previewService: PreviewService;
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
  const events = new FileEventStore(config.dataDir);
  const queue = new FileJobQueue(config.dataDir, { leaseMs: config.queueLeaseMs, clock });
  const metrics = new FileMetricsRepository(config.dataDir);
  const modelOverrides = new FileModelOverrideRepository(config.dataDir);
  const workflows = new YamlWorkflowRepository(config.workflowsDir);
  const policies = new YamlPolicyRepository(config.policiesDir);
  const harness = new VersionedHarnessRepository(config.harnessDir);
  const workspaces = new FileWorkspaceManager(config.dataDir, {
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  });
  const catalog = await loadModelCatalog(config.modelCatalogPath, env);
  const router = new ScoreBasedModelRouter(catalog, metrics);
  const executors =
    config.executorMode === 'mock'
      ? new MockExecutorRegistry(new MockAgentExecutor())
      : new StaticExecutorRegistry([
          new CodexCliExecutor(config.maxCliOutputBytes),
          new ClaudeCliExecutor(config.maxCliOutputBytes),
          new AgyCliExecutor(config.maxCliOutputBytes),
        ]);
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
    policies,
    harness,
    router,
    metrics,
    executors,
    verifier,
    workspaces,
    clock,
    ids,
    { agentTimeoutMs: config.agentTimeoutMs, cancelPollIntervalMs: config.cancelPollIntervalMs },
    modelOverrides,
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
  );
  const worker = new WorkerLoop(queue, orchestrator, {
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
    events,
    queue,
    metrics,
    modelOverrides,
    workflows,
    policies,
    harness,
    workspaces,
    router,
    executors,
    verifier,
    projectService,
    orchestrator,
    worker,
    leaseReaper,
    previewRunner,
    previewSessions,
    previewLogs,
    previewLifecycleLock,
    previewService,
  };
}
