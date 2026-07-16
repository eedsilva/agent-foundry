import {
  MockAgentExecutor,
  MockExecutorRegistry,
  StaticExecutorRegistry,
  CodexCliExecutor,
  ClaudeCliExecutor,
  AgyCliExecutor,
  WorkspaceVerifier,
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
  FileProjectRepository,
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
  };
}
