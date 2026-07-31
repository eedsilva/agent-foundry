import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type {
  AgentArtifact,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentStep,
  AgentStreamEventInput,
  ApprovalGateStep,
  ApprovalRequest,
  ArtifactReference,
  ExecutableStep,
  ExecutorStreamEvent,
  ForEachTaskStep,
  PlanTask,
  TaskBrowserAssertion,
  PreviewSession,
  Project,
  ProjectEvent,
  ProjectPolicy,
  ProvisioningFailureDiagnostic,
  QualityLoopStep,
  RankedModel,
  RunError,
  RunPauseSnapshot,
  RunRetryDirective,
  RouteDecision,
  StepAttempt,
  StepRun,
  StoredArtifact,
  TaskProfile,
  VerifyStep,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  AGENT_ARTIFACT_JSON_SCHEMA,
  AgentArtifactSchema,
  BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA,
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
  EXECUTION_PROTOCOL_VERSION,
  formatZodIssues,
  isWorkflowRunStatusTerminal,
  PROVISIONING_FAILURE_CONTEXT_MAX_BYTES,
  PROVISIONING_FAILURE_LOG_MAX_BYTES,
  ProvisioningFailureDiagnosticSchema,
  resolveRoutingEntry,
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  TaskGraphArtifactSchema,
  VerificationReportSchema,
} from '@agent-foundry/contracts';
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  Clock,
  EventStore,
  ExecutionPlane,
  ExecutorRegistry,
  ExplicitModelRoute,
  GeneratedProjectRuntime,
  HarnessRepository,
  HarnessSelection,
  IdGenerator,
  JobQueue,
  MetricsRepository,
  ModelRouter,
  ModelOverrideRepository,
  PolicyRepository,
  ProjectRepository,
  RouterDecisionLogRepository,
  SecretStore,
  StepAttemptRepository,
  StepEventRepository,
  StepRunRepository,
  VerificationService,
  WorkflowRunRepository,
  WorkflowRepository,
  WorkspaceManager,
} from '@agent-foundry/domain';
import {
  ApprovalRejectedError,
  ApprovalRequiredError,
  EmergencyCeilingError,
  EnvironmentOperationError,
  ExecutionError,
  LeaseLostError,
  NotFoundError,
  PolicyViolationError,
  ProviderAuthenticationError,
  QualityGateError,
  RunCancelledError,
  RunPausedError,
  errorMessage,
  getValueAtPath,
  isRunControlFlowError,
  isTaskStepId,
  latestArtifactsByName,
  nextReadyTask,
  normalizeApprovalDecision,
  recordRunDuration,
  recordStepRetry,
  recordTokenUsage,
  redactString,
  browserRepairId,
  taskStepId,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  VersionConflictError,
  withSpan,
  calculateUsageCostUsd,
} from '@agent-foundry/domain';
import type { PreviewService } from './preview-service.js';
import type { ProjectVersionService } from './project-version-service.js';
import { buildTaskProfile } from './task-profiler.js';
import {
  approvalGateIdempotencyKey,
  policyHash,
  stepIdempotencyKey,
  workflowHash,
} from './idempotency.js';
import { compileCliPrompt, compileRequestMarkdown, isReviewerRole } from './prompt-compiler.js';
import {
  validateBrowserVerificationReportBinding,
  type BrowserVerificationCoordinator,
} from './browser-verification-coordinator.js';
import type { QualityObservationService } from './quality-observation-service.js';

interface OrchestratorOptions {
  agentTimeoutMs: number;
  cancelPollIntervalMs: number;
}

interface DecisionLogEntry {
  recordedAt: string;
  stepId: string;
  runId: string;
  stepRunId: string;
  attemptId: string;
  role: string;
  decision: AgentArtifact['decisions'][number];
}

class ApprovalTimeoutScheduleError extends Error {
  constructor(
    readonly nodeId: string,
    cause: unknown,
  ) {
    super(`Failed to schedule approval timeout: ${errorMessage(cause)}`);
    this.name = 'ApprovalTimeoutScheduleError';
  }
}

const PROVISIONING_FAILURE_MESSAGE =
  'Project provisioning failed. Review the project event timeline for details.';

class ProjectProvisioningError extends Error {
  readonly code = 'PROJECT_PROVISIONING_FAILED';

  constructor(diagnostic: ProvisioningFailureDiagnostic) {
    super(`${diagnostic.summary}: ${diagnostic.context}`);
    this.name = 'ProjectProvisioningError';
  }
}

/** The slice of PreviewService that provisioning needs to boot a workspace. */
export type WorkspacePreviewBooter = Pick<PreviewService, 'start' | 'activeForProject'>;

/** Timeline evidence for a provisioning boot: which session, and what installed it. */
function provisionedPreviewData(session: PreviewSession): Record<string, unknown> {
  return {
    previewSessionId: session.id,
    ...(session.commandPlan?.install.ok
      ? {
          install: {
            command: session.commandPlan.install.command,
            args: session.commandPlan.install.args,
            ...(session.commandPlan.versions ? { versions: session.commandPlan.versions } : {}),
          },
        }
      : {}),
  };
}

function provisioningFailureDiagnostic(error: unknown): ProvisioningFailureDiagnostic {
  const isEnvironmentFailure = error instanceof EnvironmentOperationError;
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const phase = isEnvironmentFailure
    ? error.operation
    : typeof record.failurePhase === 'string'
      ? record.failurePhase
      : 'workspace';
  const exitCode = isEnvironmentFailure
    ? error.exitCode
    : typeof record.exitCode === 'number' && Number.isInteger(record.exitCode)
      ? record.exitCode
      : undefined;
  const evidence = [record.stderr, record.stdout].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const rawLogs = isEnvironmentFailure
    ? error.diagnostic
    : evidence.length > 0
      ? evidence.join('\n')
      : errorMessage(error);
  const logs = capProvisioningDiagnostic(deduplicateProvisioningLogs(redactString(rawLogs)));
  const phaseLabel =
    phase === 'workspace'
      ? 'Workspace'
      : isEnvironmentFailure
        ? `Supabase ${phase}`
        : `Preview ${phase}`;
  const fallbackContext = `${phaseLabel} reported a failure; inspect the bounded logs for the provider error.`;
  const lines = logs
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const genericContainerError = lines.find((line) =>
    /^error running container(?::|\s)/i.test(line),
  );
  const contextCandidate =
    lines.find(
      (line) =>
        /error|fail|unable|unreachable|unhealthy|timeout|timed out|exit/i.test(line) &&
        line !== genericContainerError,
    ) ??
    lines.find(
      (line) =>
        line !== genericContainerError && !/^(starting|initiali[sz]ing|stopping)\b/i.test(line),
    ) ??
    (genericContainerError
      ? `${phaseLabel} could not start a service. No service-specific stderr was reported; inspect the bounded logs for details.`
      : undefined) ??
    fallbackContext;
  const context = capProvisioningDiagnostic(
    contextCandidate,
    PROVISIONING_FAILURE_CONTEXT_MAX_BYTES,
  );
  return ProvisioningFailureDiagnosticSchema.parse({
    schemaVersion: '1',
    phase,
    ...(exitCode !== undefined ? { exitCode } : {}),
    summary: `${phaseLabel} provisioning failed${
      exitCode === undefined ? '' : ` (exit code ${exitCode})`
    }`,
    context,
    logs,
  });
}

function deduplicateProvisioningLogs(value: string): string {
  const seen = new Set<string>();
  return value
    .split('\n')
    .filter((line) => {
      const normalized = line.replace(/^(?:command failed|supabase command failed):\s*/i, '');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join('\n');
}

function capProvisioningDiagnostic(
  value: string,
  maxBytes = PROVISIONING_FAILURE_LOG_MAX_BYTES,
): string {
  const trimmed = value.trim();
  if (!trimmed) return 'No provisioning diagnostic available.';
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength <= maxBytes) return trimmed;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > maxBytes - 4; end -= 1) {
    try {
      return decoder.decode(bytes.slice(0, end));
    } catch {
      // Try the previous UTF-8 boundary.
    }
  }
  return '';
}

export class WorkflowOrchestrator {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly approvalRequests: ApprovalRequestRepository,
    private readonly approvalDecisions: ApprovalDecisionRepository,
    private readonly queue: JobQueue,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly stepEvents: StepEventRepository,
    private readonly workflows: WorkflowRepository,
    private readonly policies: PolicyRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly metrics: MetricsRepository,
    private readonly executionPlane: ExecutionPlane,
    private readonly verifier: VerificationService,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: OrchestratorOptions,
    private readonly modelOverrides?: ModelOverrideRepository,
    private readonly versions?: ProjectVersionService,
    private readonly browserVerification?: BrowserVerificationCoordinator,
    private readonly qualityObservations?: QualityObservationService,
    private readonly executors?: Pick<ExecutorRegistry, 'health'>,
    private readonly secretStore?: SecretStore,
    private readonly decisionLog?: RouterDecisionLogRepository,
    private readonly generatedProjectRuntime?: GeneratedProjectRuntime,
    private readonly previews?: WorkspacePreviewBooter,
  ) {}

  /**
   * Installs and boots the freshly scaffolded workspace by starting a durable
   * preview session, so a new project reaches a green preview before any agent
   * step runs (#318). Skips when the project already has a live session.
   * Returns the started session, or undefined when nothing was started.
   */
  private async bootWorkspacePreview(
    projectId: string,
    runId: string,
  ): Promise<PreviewSession | undefined> {
    if (!this.previews) return undefined;
    if (await this.previews.activeForProject(projectId)) return undefined;
    const { session } = await this.previews.start({
      workspaceRef: { projectId, workspacePath: this.workspaces.workspacePath(projectId) },
      runId,
    });
    if (session.status !== 'running') {
      throw Object.assign(
        new Error(
          session.error?.message ??
            `Preview session ${session.id} reached '${session.status}' instead of 'running' while booting the workspace.`,
        ),
        {
          failurePhase: session.failurePhase,
          exitCode: session.failureEvidence?.exitCode ?? session.error?.exitCode,
          stdout: session.failureEvidence?.stdout,
          stderr: session.failureEvidence?.stderr,
        },
      );
    }
    return session;
  }

  async runProject(
    projectId: string,
    workflowId?: string,
    requestedRunId?: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    return withSpan('foundry.run', { 'foundry.project.id': projectId }, (span) =>
      this.runProjectTraced(projectId, span, workflowId, requestedRunId, externalSignal),
    );
  }

  private async runProjectTraced(
    projectId: string,
    span: Span,
    workflowId?: string,
    requestedRunId?: string,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    const project = await this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    const workflow = await this.workflows.get(workflowId ?? project.workflowId);
    let run = requestedRunId ? await this.runs.get(requestedRunId) : null;
    if (!run) run = await this.createLegacyCompatibleRun(project, workflow.id, requestedRunId);
    if (run.projectId !== projectId || run.workflowId !== workflow.id) {
      throw new ExecutionError(
        `Run ${run.id} does not belong to project/workflow ${projectId}/${workflow.id}`,
      );
    }
    span.setAttribute('foundry.run.id', run.id);
    span.setAttribute('foundry.workflow.id', workflow.id);
    const cancellation = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([cancellation.signal, externalSignal])
      : cancellation.signal;
    const stopWatching = this.watchForCancellation(run.id, cancellation);
    try {
      throwIfCancelled(signal, run.id);
      // A ceiling can crash after the terminal state write but before summary
      // sync or event append, so failed redelivery finishes those idempotently.
      if (run.status === 'failed' && run.execution?.ceiling) {
        throwIfCancelled(signal, run.id);
        await this.finalizeEmergencyCeiling(run.id, projectId);
        return;
      }
      if (isWorkflowRunStatusTerminal(run.status)) {
        throwIfCancelled(signal, run.id);
        return;
      }
      if (run.status === 'cancel_requested') {
        throwIfCancelled(signal, run.id);
        await this.finalizeCancellation(run.id, projectId);
        return;
      }
      if (run.status === 'pause_requested') {
        throwIfCancelled(signal, run.id);
        await this.finalizePause(run.id, projectId, workflow);
        return;
      }
      if (this.generatedProjectRuntime || this.previews) {
        if (run.status !== 'running') {
          run = await this.runs.update(
            transitionWorkflowRun(run, 'running', this.clock.now()),
            run.version,
          );
          await this.syncProjectSummary(run);
        }
        await this.emit(
          projectId,
          'project.provisioning_started',
          'Project provisioning started.',
          {
            runId: run.id,
            dedupeKey: `${run.id}:project.provisioning_started`,
          },
        );
        let bootedPreview: PreviewSession | undefined;
        try {
          await this.generatedProjectRuntime?.initialize({ projectId });
          bootedPreview = await this.bootWorkspacePreview(projectId, run.id);
        } catch (error) {
          const diagnostic = provisioningFailureDiagnostic(error);
          await this.emit(projectId, 'project.provisioning_failed', PROVISIONING_FAILURE_MESSAGE, {
            runId: run.id,
            dedupeKey: `${run.id}:project.provisioning_failed`,
            data: { diagnostic },
          });
          throw new ProjectProvisioningError(diagnostic);
        }
        await this.emit(projectId, 'project.provisioned', 'Project provisioning completed.', {
          runId: run.id,
          dedupeKey: `${run.id}:project.provisioned`,
          ...(bootedPreview ? { data: provisionedPreviewData(bootedPreview) } : {}),
        });
      }
      await this.workspaces.ensureGit(projectId);
      run = await this.ensureInitialVerifiedCheckpoint(run.id, projectId);
      if (run.execution?.ceiling) {
        throw new EmergencyCeilingError(run.id, run.execution.ceiling.reason);
      }
      if (run.status !== 'running') {
        run = await this.runs.update(
          transitionWorkflowRun(run, 'running', this.clock.now()),
          run.version,
        );
      }
      run = await this.startActiveExecution(run.id);
      await this.assertExecutionMayContinue(run.id, signal);
      await this.syncProjectSummary(run);
      await this.emit(projectId, 'project.started', `Workflow ${workflow.id} started.`, {
        runId: run.id,
        dedupeKey: `${run.id}:project.started`,
      });
      run = await this.enforceRunPolicy(run, project, workflow);
      for (const node of workflow.nodes) {
        throwIfCancelled(signal, run.id);
        await this.assertExecutionMayContinue(run.id, signal);
        await this.emit(projectId, 'node.started', node.title, {
          nodeId: node.id,
          runId: run.id,
          dedupeKey: `${run.id}:node:${node.id}:started`,
        });
        await this.executeNode(project, workflow, node, run.id, signal);
        await this.emit(projectId, 'node.completed', node.title, {
          nodeId: node.id,
          runId: run.id,
          dedupeKey: `${run.id}:node:${node.id}:completed`,
        });
      }
      await this.assertExecutionMayContinue(run.id, signal);
      run = await this.completeRun(run.id, signal);
      throwIfCancelled(signal, run.id);
      await this.syncProjectSummary(run);
      throwIfCancelled(signal, run.id);
      const durationMs = Date.now() - startedAt;
      span.setAttribute('foundry.run.duration_ms', durationMs);
      recordRunDuration(durationMs, { status: 'completed' });
      // No dedupe key here: a terminal run early-returns on redelivery, and a
      // step retry legitimately completes the same run a second time.
      await this.emit(projectId, 'project.completed', `Workflow ${workflow.id} completed.`, {
        runId: run.id,
      });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (error instanceof ApprovalTimeoutScheduleError) {
        throwIfCancelled(signal, run.id);
        await this.finalizeApproval(run.id, projectId, error.nodeId);
        throw error;
      }
      if (error instanceof RunPausedError) {
        await this.finalizePause(run.id, projectId, workflow, error.nodeId);
        return;
      }
      if (error instanceof ApprovalRequiredError) {
        throwIfCancelled(signal, run.id);
        await this.finalizeApproval(run.id, projectId, error.nodeId);
        return;
      }
      if (error instanceof ApprovalRejectedError) {
        await this.finalizeRejection(run.id, projectId, error.nodeId, error.decidedBy, error.note);
        return;
      }
      if (isCancellation(error, signal)) {
        await this.finalizeCancellation(run.id, projectId);
        return;
      }
      if (error instanceof EmergencyCeilingError) {
        const latest = await this.requireRun(run.id);
        if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
          throwIfCancelled(signal, run.id);
          await this.finalizeCancellation(run.id, projectId);
          return;
        }
        throwIfCancelled(signal, run.id);
        if (!(await this.finalizeEmergencyCeiling(run.id, projectId))) return;
        throw error;
      }
      const latest = await this.stopActiveExecution(run.id);
      throwIfCancelled(signal, run.id);
      if (latest.status === 'running' || latest.status === 'pause_requested') {
        run = await this.runs.update(
          transitionWorkflowRun(latest, 'failed', this.clock.now(), { error: runError(error) }),
          latest.version,
        );
      } else {
        run = latest;
      }
      await this.syncProjectSummary(run);
      const durationMs = Date.now() - startedAt;
      span.setAttribute('foundry.run.duration_ms', durationMs);
      recordRunDuration(durationMs, { status: 'failed' });
      await this.emit(
        projectId,
        'project.failed',
        error instanceof ProjectProvisioningError
          ? PROVISIONING_FAILURE_MESSAGE
          : errorMessage(error),
        {
          runId: run.id,
          dedupeKey: `${run.id}:project.failed`,
        },
      );
      throw error;
    } finally {
      stopWatching();
    }
  }

  private async startActiveExecution(runId: string): Promise<WorkflowRun> {
    return this.updateExecution(runId, (run, now) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      return execution.activeSince || execution.ceiling
        ? execution
        : { ...execution, activeSince: now.toISOString() };
    });
  }

  private async stopActiveExecution(runId: string): Promise<WorkflowRun> {
    return this.updateExecution(runId, (run, now) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      if (!execution.activeSince) return execution;
      const activeElapsedMs =
        execution.activeElapsedMs + Math.max(0, now.getTime() - Date.parse(execution.activeSince));
      const { activeSince: _activeSince, ...inactive } = execution;
      return { ...inactive, activeElapsedMs };
    });
  }

  private async completeRun(runId: string, signal?: AbortSignal): Promise<WorkflowRun> {
    if (signal) throwIfCancelled(signal, runId);
    await this.stopActiveExecution(runId);
    await this.assertExecutionMayContinue(runId, signal);
    for (;;) {
      if (signal) throwIfCancelled(signal, runId);
      const run = await this.requireRun(runId);
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        throw new RunCancelledError(runId);
      }
      if (run.execution?.ceiling) {
        throw new EmergencyCeilingError(runId, run.execution.ceiling.reason);
      }
      if (run.status === 'completed') return run;
      try {
        if (signal) throwIfCancelled(signal, runId);
        return await this.runs.update(
          transitionWorkflowRun(run, 'completed', this.clock.now()),
          run.version,
        );
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
  }

  private async assertExecutionMayContinue(runId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfCancelled(signal, runId);
    const run = await this.requireRun(runId);
    if (run.status === 'cancel_requested' || run.status === 'cancelled') {
      throw new RunCancelledError(runId);
    }
    if (run.execution?.ceiling) {
      throw new EmergencyCeilingError(runId, run.execution.ceiling.reason);
    }
    const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
    const activeElapsedMs =
      execution.activeElapsedMs +
      (execution.activeSince
        ? Math.max(0, this.clock.now().getTime() - Date.parse(execution.activeSince))
        : 0);
    if (activeElapsedMs >= 14_400_000) await this.reachCeiling(runId, 'active-time', signal);
  }

  private async classifyFailure(
    runId: string,
    signal: AbortSignal,
    error: unknown,
  ): Promise<unknown> {
    try {
      await this.assertExecutionMayContinue(runId, signal);
      return error;
    } catch (boundaryError) {
      if (
        boundaryError instanceof EmergencyCeilingError ||
        boundaryError instanceof RunCancelledError
      ) {
        return boundaryError;
      }
      throw boundaryError;
    }
  }

  private async recordCompletedRepair(
    runId: string,
    nodeId: string,
    stepId: string,
    iteration: number,
    signal: AbortSignal,
  ): Promise<void> {
    await this.assertExecutionMayContinue(runId, signal);
    const repair = (await this.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          candidate.iteration === iteration &&
          candidate.status === 'completed',
      )
      .at(-1);
    if (!repair) throw new ExecutionError(`Completed repair ${nodeId}/${stepId} was not persisted`);
    const updated = await this.updateExecution(runId, (run) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      const countedRepairStepRunIds = execution.countedRepairStepRunIds ?? [];
      return countedRepairStepRunIds.includes(repair.id)
        ? execution
        : {
            ...execution,
            consecutiveRepairs: execution.consecutiveRepairs + 1,
            countedRepairStepRunIds: [...countedRepairStepRunIds, repair.id].slice(-10),
          };
    });
    if ((updated.execution?.consecutiveRepairs ?? 0) >= 10) {
      await this.reachCeiling(runId, 'consecutive-repairs', signal);
    }
  }

  private async resetConsecutiveRepairs(runId: string): Promise<void> {
    await this.updateExecution(runId, (run) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      return execution.consecutiveRepairs === 0 && !execution.countedRepairStepRunIds?.length
        ? execution
        : { ...execution, consecutiveRepairs: 0, countedRepairStepRunIds: [] };
    });
  }

  private async reachCeiling(
    runId: string,
    reason: 'active-time' | 'consecutive-repairs',
    signal?: AbortSignal,
  ): Promise<never> {
    if (signal) throwIfCancelled(signal, runId);
    const updated = await this.updateExecution(runId, (run, now) => {
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        throw new RunCancelledError(runId);
      }
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      if (execution.ceiling) return execution;
      const activeElapsedMs =
        execution.activeElapsedMs +
        (execution.activeSince
          ? Math.max(0, now.getTime() - Date.parse(execution.activeSince))
          : 0);
      const { activeSince: _activeSince, ...inactive } = execution;
      return {
        ...inactive,
        activeElapsedMs,
        ceiling: { reason, reachedAt: now.toISOString() },
      };
    });
    throw new EmergencyCeilingError(runId, updated.execution?.ceiling?.reason ?? reason);
  }

  private async updateExecution(
    runId: string,
    update: (run: WorkflowRun, now: Date) => NonNullable<WorkflowRun['execution']>,
  ): Promise<WorkflowRun> {
    for (;;) {
      const run = await this.requireRun(runId);
      const now = this.clock.now();
      const execution = update(run, now);
      if (run.execution === execution) return run;
      try {
        return await this.runs.update(
          { ...run, execution, updatedAt: now.toISOString() },
          run.version,
        );
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
  }

  private watchForCancellation(runId: string, controller: AbortController): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout;
    const poll = async (): Promise<void> => {
      if (stopped || controller.signal.aborted) return;
      try {
        const run = await this.runs.get(runId);
        if (run && (run.status === 'cancel_requested' || run.status === 'cancelled')) {
          controller.abort(new RunCancelledError(runId));
          return;
        }
        await this.assertExecutionMayContinue(runId);
      } catch (error) {
        if (error instanceof EmergencyCeilingError) {
          controller.abort(error);
          return;
        }
        // Transient read failures must not kill the watcher; the next tick retries.
      }
      if (!stopped) timer = setTimeout(() => void poll(), this.options.cancelPollIntervalMs);
    };
    timer = setTimeout(() => void poll(), this.options.cancelPollIntervalMs);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  private async finalizeCancellation(runId: string, projectId: string): Promise<void> {
    let run = await this.stopActiveExecution(runId);
    if (run.status === 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'cancel_requested', this.clock.now()),
        run.version,
      );
    }
    if (run.status !== 'cancelled') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'cancelled', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run);
    await this.emit(projectId, 'run.cancelled', 'Workflow run cancelled.', { runId });
  }

  private async ensureInitialVerifiedCheckpoint(
    runId: string,
    projectId: string,
  ): Promise<WorkflowRun> {
    const existing = await this.requireRun(runId);
    if (existing.execution?.lastVerifiedCheckpoint) return existing;
    const checkpoint =
      (await this.workspaces.head(projectId)) ??
      (await this.workspaces.checkpoint(projectId, `${runId}-initial`));
    return this.updateExecution(runId, (run) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      return execution.lastVerifiedCheckpoint
        ? execution
        : { ...execution, lastVerifiedCheckpoint: checkpoint };
    });
  }

  private async finalizeEmergencyCeiling(runId: string, projectId: string): Promise<boolean> {
    let run = await this.requireRun(runId);
    if (run.status === 'cancel_requested' || run.status === 'cancelled') {
      await this.finalizeCancellation(runId, projectId);
      return false;
    }
    const ceiling = run.execution?.ceiling;
    const verifiedCheckpoint = run.execution?.lastVerifiedCheckpoint;
    if (!ceiling || !verifiedCheckpoint) {
      throw new ExecutionError(`Run ${runId} is missing emergency ceiling checkpoint evidence`);
    }
    if (!ceiling.draftBranch) {
      const draft = await this.workspaces.preserveDraft(projectId, runId, verifiedCheckpoint);
      const { draftBranch, draftCommit } = draft;
      run = await this.requireRun(runId);
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        if (draft.created) {
          await this.workspaces.discardDraft(projectId, runId, draft.draftCommit);
        }
        await this.finalizeCancellation(runId, projectId);
        return false;
      }
      try {
        run = await this.updateExecution(runId, (latest) => {
          if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
            throw new RunCancelledError(runId);
          }
          return {
            ...(latest.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
            ceiling: { ...latest.execution!.ceiling!, draftBranch, draftCommit },
          };
        });
      } catch (error) {
        if (!(error instanceof RunCancelledError)) throw error;
        if (draft.created) {
          await this.workspaces.discardDraft(projectId, runId, draft.draftCommit);
        }
        await this.finalizeCancellation(runId, projectId);
        return false;
      }
    }
    run = await this.requireRun(runId);
    if (run.status === 'cancel_requested' || run.status === 'cancelled') {
      await this.finalizeCancellation(runId, projectId);
      return false;
    }
    while (run.status !== 'failed') {
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        await this.finalizeCancellation(runId, projectId);
        return false;
      }
      const error = new EmergencyCeilingError(runId, ceiling.reason);
      try {
        run = await this.runs.update(
          transitionWorkflowRun(run, 'failed', this.clock.now(), { error: runError(error) }),
          run.version,
        );
      } catch (updateError) {
        if (!(updateError instanceof VersionConflictError)) throw updateError;
        run = await this.requireRun(runId);
      }
    }
    await this.syncProjectSummary(run);
    await this.emit(
      projectId,
      'run.emergency_ceiling_reached',
      errorMessage(new EmergencyCeilingError(runId, ceiling.reason)),
      {
        runId,
        dedupeKey: `${runId}:emergency-ceiling`,
        data: { reason: ceiling.reason, draftBranch: run.execution?.ceiling?.draftBranch },
      },
    );
    return true;
  }

  /**
   * Turns a pause request into a paused run at a step boundary, capturing the
   * compatibility snapshot resume validates against. A cancel that raced the
   * pause wins.
   */
  private async finalizePause(
    runId: string,
    projectId: string,
    workflow: WorkflowDefinition,
    resumeNodeId?: string,
  ): Promise<void> {
    let run = await this.requireRun(runId);
    if (run.status === 'cancel_requested' || run.status === 'cancelled') {
      await this.finalizeCancellation(runId, projectId);
      return;
    }
    if (run.status === 'pause_requested') {
      run = await this.stopActiveExecution(runId);
      const snapshot = await this.pauseSnapshot(projectId, workflow, resumeNodeId);
      run = await this.runs.update(
        transitionWorkflowRun(run, 'paused', this.clock.now(), { pause: snapshot }),
        run.version,
      );
    }
    await this.syncProjectSummary(run);
    await this.emit(
      projectId,
      'run.paused',
      resumeNodeId ? `Run paused before ${resumeNodeId}.` : 'Run paused.',
      {
        runId,
        ...(resumeNodeId ? { nodeId: resumeNodeId } : {}),
        data: { ...(resumeNodeId ? { resumeNodeId } : {}) },
      },
    );
  }

  private async finalizeApproval(runId: string, projectId: string, nodeId: string): Promise<void> {
    let run = await this.stopActiveExecution(runId);
    if (run.status === 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'awaiting_approval', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run, nodeId);
    await this.emit(projectId, 'run.approval_requested', `Awaiting approval at ${nodeId}.`, {
      runId,
      nodeId,
    });
  }

  private async finalizeRejection(
    runId: string,
    projectId: string,
    nodeId: string,
    decidedBy: string,
    note?: string,
  ): Promise<void> {
    let run = await this.stopActiveExecution(runId);
    if (run.status === 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'rejected', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run, nodeId);
    // The operator's reason rides the terminal event: a rejected run has no
    // later step to carry it, and the timeline is where the operator looks.
    await this.emit(
      projectId,
      'run.rejected',
      `Rejected at ${nodeId} by ${decidedBy}.${note ? ` Reason: ${note}` : ''}`,
      { runId, nodeId, ...(note ? { data: { reason: note } } : {}) },
    );
  }

  /**
   * Pins the run to the policy it started under and blocks execution when the
   * policy content changed mid-run — retrying the project (a fresh run) is
   * the explicit fork that adopts the new policy.
   */
  private async enforceRunPolicy(
    run: WorkflowRun,
    project: Project,
    workflow: WorkflowDefinition,
  ): Promise<WorkflowRun> {
    const policy = await this.policies.get(project.policyId);
    const hash = policyHash(policy);
    if (run.policy && run.policy.hash !== hash) {
      throw await this.policyChanged(project.id, run.id, run.policy, policy, hash);
    }
    if (!run.policy) {
      run = await this.runs.update(
        {
          ...run,
          policy: { id: policy.id, version: policy.version, hash },
          updatedAt: this.clock.now().toISOString(),
        },
        run.version,
      );
    }
    if (policy.requiredStack && policy.requiredStack !== workflow.stack) {
      const message = `Workflow ${workflow.id} stack '${workflow.stack}' violates policy ${policy.id}@v${policy.version} requiredStack '${policy.requiredStack}'.`;
      await this.emit(project.id, 'policy.violation', message, {
        runId: run.id,
        data: { requiredStack: policy.requiredStack, stack: workflow.stack },
      });
      throw new PolicyViolationError(message);
    }
    return run;
  }

  /** Emits the audit event for a mid-run policy content change and builds the error. */
  private async policyChanged(
    projectId: string,
    runId: string,
    pinned: NonNullable<WorkflowRun['policy']>,
    current: ProjectPolicy,
    currentHash: string,
    nodeId?: string,
  ): Promise<PolicyViolationError> {
    const message =
      `Policy ${current.id} changed (v${pinned.version} → v${current.version}) while run ${runId} was in flight. ` +
      'Retry the project to fork a new run under the current policy.';
    await this.emit(projectId, 'policy.violation', message, {
      runId,
      ...(nodeId ? { nodeId } : {}),
      data: { field: 'policyHash', expected: pinned.hash, actual: currentHash },
    });
    return new PolicyViolationError(message);
  }

  private async pauseSnapshot(
    projectId: string,
    workflow: WorkflowDefinition,
    resumeNodeId?: string,
  ): Promise<RunPauseSnapshot> {
    const latest = latestArtifactsByName(await this.artifacts.listMetadata(projectId));
    return {
      workflowHash: workflowHash(workflow),
      harnessVersion: await this.harness.version(),
      workspaceHead: await this.workspaces.head(projectId),
      artifactHashes: Object.fromEntries(
        [...latest.entries()].map(([name, item]) => [name, item.sha256]),
      ),
      ...(resumeNodeId ? { resumeNodeId } : {}),
    };
  }

  private async executeNode(
    project: Project,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    if (node.type === 'quality-loop')
      return this.executeQualityLoop(project, workflow, node, runId, signal);
    if (node.type === 'for-each-task')
      return this.executeForEachTask(project, workflow, node, runId, signal);
    if (node.type === 'approval-gate')
      return this.executeApprovalGate(project, node, runId, signal);
    return this.executeStep(project, workflow, node, runId, node.id, signal);
  }

  /**
   * Halts the run until a human decision is persisted. Reuse is keyed on the
   * output artifact's idempotency key rather than StepAttempts (a gate never
   * has any): once approved, the keyed artifact alone proves it's resolved.
   * request-changes and reject+return-to-step are never observed here —
   * ProjectService.decideApproval invalidates this StepRun before requeueing,
   * so the next replay takes the "no pending StepRun" branch below instead.
   */
  private async executeApprovalGate(
    project: Project,
    node: ApprovalGateStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': node.id,
        'foundry.step.id': node.id,
        'foundry.step.type': 'approval-gate',
      },
      () => this.executeApprovalGateTraced(project, node, runId, signal),
    );
  }

  private async executeApprovalGateTraced(
    project: Project,
    node: ApprovalGateStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    throwIfCancelled(signal, runId);
    const reviewed = await this.artifacts.getLatest(project.id, node.artifact);
    throwIfCancelled(signal, runId);
    if (!reviewed) throw new NotFoundError(`Missing input artifact(s): ${node.artifact}`);
    const idempotencyKey = approvalGateIdempotencyKey({
      runId,
      nodeId: node.id,
      artifact: artifactReference(reviewed),
    });

    const reused = await this.findArtifactByKey(project.id, node.outputArtifact, idempotencyKey);
    throwIfCancelled(signal, runId);
    if (reused) return reused;

    let stepRun = (await this.stepRuns.list(runId)).find(
      (candidate) =>
        candidate.nodeId === node.id && candidate.stepId === node.id && !candidate.invalidatedAt,
    );
    throwIfCancelled(signal, runId);

    if (!stepRun) {
      const timestamp = this.clock.now().toISOString();
      stepRun = {
        id: this.ids.next(),
        runId,
        nodeId: node.id,
        stepId: node.id,
        stepType: 'approval-gate',
        idempotencyKey,
        status: 'pending',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.stepRuns.create(stepRun);
      throwIfCancelled(signal, runId);
      stepRun = await this.stepRuns.update(
        transitionStepRun(stepRun, 'running', this.clock.now()),
        stepRun.version,
      );
      throwIfCancelled(signal, runId);
      await this.setCurrentStep(runId, stepRun, node.id, signal);

      const requestTimestamp = this.clock.now();
      const timeout =
        node.timeout.policy !== 'none' && node.timeout.afterMs !== undefined
          ? {
              timeout: { policy: node.timeout.policy, afterMs: node.timeout.afterMs },
              timeoutAt: new Date(requestTimestamp.getTime() + node.timeout.afterMs).toISOString(),
            }
          : {};
      const approvalRequestId = this.ids.next();
      throwIfCancelled(signal, runId);
      const approvalRequest: ApprovalRequest = {
        id: approvalRequestId,
        runId,
        stepRunId: stepRun.id,
        nodeId: node.id,
        artifact: artifactReference(reviewed),
        allowedActions: node.actions,
        ...timeout,
        createdAt: requestTimestamp.toISOString(),
      };
      await this.approvalRequests.create(approvalRequest);
      throwIfCancelled(signal, runId);
      await this.enqueueApprovalTimeout(project, node.id, approvalRequest);
      throwIfCancelled(signal, runId);
      await this.stepEvents
        .append({
          id: this.ids.next(),
          runId,
          stepRunId: stepRun.id,
          createdAt: this.clock.now().toISOString(),
          type: 'approval',
          approvalRequestId,
        })
        .catch(() => undefined);
      throwIfCancelled(signal, runId);
      throw new ApprovalRequiredError(runId, node.id);
    }

    const request = await this.approvalRequests.getForStepRun(runId, stepRun.id);
    throwIfCancelled(signal, runId);
    if (!request) {
      throw new ExecutionError(
        `Approval gate ${node.id} has a pending StepRun but no ApprovalRequest`,
      );
    }
    let decision = normalizeApprovalDecision(await this.approvalDecisions.get(runId, request.id));
    throwIfCancelled(signal, runId);
    const timeoutPolicy = request.timeout?.policy;
    if (!decision && request.timeoutAt && new Date(request.timeoutAt) > this.clock.now()) {
      await this.enqueueApprovalTimeout(project, node.id, request);
      throwIfCancelled(signal, runId);
    }
    if (
      !decision &&
      request.timeoutAt &&
      timeoutPolicy &&
      timeoutPolicy !== 'none' &&
      new Date(request.timeoutAt) <= this.clock.now()
    ) {
      const decidedAt = this.clock.now().toISOString();
      decision = {
        id: this.ids.next(),
        requestId: request.id,
        runId,
        stepRunId: request.stepRunId,
        action: timeoutPolicy === 'auto-approve' ? 'approve' : 'reject',
        decidedBy: 'system:approval-timeout',
        decidedAt,
      };
      throwIfCancelled(signal, runId);
      await this.approvalDecisions.create(decision);
      throwIfCancelled(signal, runId);
    }
    if (!decision) throw new ApprovalRequiredError(runId, node.id);

    if (decision.action === 'reject') {
      throw new ApprovalRejectedError(runId, node.id, decision.decidedBy, decision.note);
    }
    if (decision.action === 'request-changes') {
      throw new ExecutionError(
        `Approval gate ${node.id} decision 'request-changes' was not applied before replay`,
      );
    }

    const artifact = await this.artifacts.put({
      projectId: project.id,
      name: node.outputArtifact,
      content: { schemaVersion: '1', requestId: request.id, decision },
      createdBy: `approval-gate:${node.id}`,
      runId,
      stepRunId: stepRun.id,
      idempotencyKey,
    });
    throwIfCancelled(signal, runId);
    await this.stepRuns.update(
      transitionStepRun(stepRun, 'completed', this.clock.now()),
      stepRun.version,
    );
    throwIfCancelled(signal, runId);
    await this.clearCurrentStep(runId, signal);
    throwIfCancelled(signal, runId);
    await this.emit(project.id, 'run.approval_decided', `${node.title} approved.`, {
      nodeId: node.id,
      runId,
      data: { action: decision.action, decidedBy: decision.decidedBy },
    });
    throwIfCancelled(signal, runId);
    await this.emitArtifactCreated(project.id, artifact, node.id, runId);
    return artifact;
  }

  private async enqueueApprovalTimeout(
    project: Project,
    nodeId: string,
    request: ApprovalRequest,
  ): Promise<void> {
    if (!request.timeoutAt) return;
    try {
      await this.queue.enqueue({
        id: `${request.runId}:approval-timeout:${request.id}`,
        type: 'run-project',
        projectId: project.id,
        workflowId: project.workflowId,
        runId: request.runId,
        attempts: 0,
        maxAttempts: 1,
        createdAt: request.createdAt,
        availableAt: request.timeoutAt,
        leaseEpoch: 0,
      });
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      throw new ApprovalTimeoutScheduleError(nodeId, error);
    }
  }

  private async executeQualityLoop(
    project: Project,
    workflow: WorkflowDefinition,
    node: QualityLoopStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': node.id,
        'foundry.step.id': node.id,
        'foundry.step.type': 'quality-loop',
      },
      () => this.executeQualityLoopTraced(project, workflow, node, runId, signal),
    );
  }

  private async executeQualityLoopTraced(
    project: Project,
    workflow: WorkflowDefinition,
    node: QualityLoopStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    let qualitySubject: StoredArtifact | null = null;
    let browserPlan: ArtifactReference | undefined;
    if (node.setup) {
      const setupArtifact = await this.executeStep(
        project,
        workflow,
        node.setup,
        runId,
        node.id,
        signal,
        1,
      );
      if (node.setup.type === 'agent') qualitySubject = setupArtifact;
      if (
        node.check.type === 'verify' &&
        node.check.browserTestPlanArtifact === setupArtifact.metadata.name
      ) {
        browserPlan = artifactReference(setupArtifact);
      }
    }
    if (!qualitySubject && node.check.type === 'agent' && isReviewerRole(node.check.role)) {
      // The reviewed artifact is the first input carrying a route decision, so
      // a workflow lists the artifact under review first.
      // ponytail: quality loops normally have few inputs; add a route-decision
      // lookup to ArtifactStore if workflows begin reviewing large artifact sets.
      qualitySubject =
        (await this.loadInputArtifacts(project.id, node.check.inputArtifacts)).find(
          (artifact) => artifact.metadata.routeDecision,
        ) ?? null;
    }

    const loopStartedAt = this.clock.now().getTime();
    let latest: StoredArtifact | null = null;
    for (let iteration = 1; ; iteration += 1) {
      await this.assertExecutionMayContinue(runId, signal);
      latest = await this.executeStep(
        project,
        workflow,
        node.check,
        runId,
        node.id,
        signal,
        iteration,
        browserPlan ? [browserPlan] : [],
      );
      const approved = this.conditionApproved(latest, node);
      if (qualitySubject) {
        await this.recordQualityOutcome(qualitySubject, approved);
        await this.appendDecisionLog(
          project.id,
          workflow.id,
          node.id,
          runId,
          qualitySubject,
          approved,
          iteration,
          this.clock.now().getTime() - loopStartedAt,
        );
        if (node.check.type === 'verify') {
          await this.qualityObservations?.recordDeterministic(qualitySubject, latest, approved);
        } else if (isReviewerRole(node.check.role)) {
          await this.qualityObservations?.recordBlindReview(qualitySubject, latest, approved);
        }
      }
      if (approved) {
        await this.resetConsecutiveRepairs(runId);
        await this.emit(project.id, 'quality.approved', `${node.title} approved.`, {
          runId,
          nodeId: node.id,
          dedupeKey: `${runId}:quality:${node.id}:${iteration}:approved`,
          data: { iteration },
        });
        return latest;
      }

      await this.emit(project.id, 'quality.repair_requested', `${node.title} requires repair.`, {
        runId,
        nodeId: node.id,
        dedupeKey: `${runId}:quality:${node.id}:${iteration}:repair_requested`,
        data: { iteration },
      });
      qualitySubject = await this.executeStep(
        project,
        workflow,
        node.repair,
        runId,
        node.id,
        signal,
        iteration,
        [...(browserPlan ? [browserPlan] : []), artifactReference(latest)],
      );
      await this.recordCompletedRepair(runId, node.id, node.repair.id, iteration, signal);
    }
  }

  private conditionApproved(artifact: StoredArtifact, node: QualityLoopStep): boolean {
    if (artifact.metadata.name !== node.approval.artifact) return false;
    return getValueAtPath(artifact.content, node.approval.path) === node.approval.equals;
  }

  private async executeForEachTask(
    project: Project,
    workflow: WorkflowDefinition,
    node: ForEachTaskStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': node.id,
        'foundry.step.id': node.id,
        'foundry.step.type': 'for-each-task',
      },
      () => this.executeForEachTaskTraced(project, workflow, node, runId, signal),
    );
  }

  /**
   * Walks the task graph one task at a time, in dependency order, running the
   * node's implement step per task. The graph revision read here is pinned
   * into every task's inputs, so a replay after a pause reuses the exact same
   * step identities and resumes at the first task that has not completed.
   */
  private async executeForEachTaskTraced(
    project: Project,
    workflow: WorkflowDefinition,
    node: ForEachTaskStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    const graphArtifact = await this.artifacts.getLatest(project.id, node.taskGraphArtifact);
    if (!graphArtifact) {
      throw new NotFoundError(`Missing input artifact(s): ${node.taskGraphArtifact}`);
    }
    const parsed = TaskGraphArtifactSchema.safeParse(graphArtifact.content);
    if (!parsed.success) {
      throw new ExecutionError(
        `Node ${node.id} cannot walk ${node.taskGraphArtifact}: ${formatZodIssues(parsed.error, node.taskGraphArtifact)}`,
      );
    }
    const tasks = parsed.data.data.tasks;
    // Every task reads the same input revisions — resolved once, before the
    // first task runs. Re-reading them per task would let a sibling write
    // change a later task's inputs, and with them its step identity.
    const pinnedInputs = (
      await this.loadInputArtifacts(project.id, node.implement.inputArtifacts, [
        artifactReference(graphArtifact),
      ])
    ).map(artifactReference);
    const completed = new Set<string>();
    let latest: StoredArtifact | null = null;
    while (completed.size < tasks.length) {
      const task = nextReadyTask(tasks, completed);
      if (!task) {
        throw new ExecutionError(
          `Node ${node.id} has no runnable task left in ${node.taskGraphArtifact} with ${completed.size}/${tasks.length} complete`,
        );
      }
      latest = await this.executeTask(project, workflow, node, task, runId, signal, pinnedInputs);
      completed.add(task.id);
    }
    if (!latest) throw new ExecutionError(`Node ${node.id} walked an empty task graph`);
    return latest;
  }

  /**
   * One task: bounded attempts of the implement step, the task's deterministic
   * gate, then its own commit. The checkpoint taken before the first attempt is
   * what a task that never goes green is rolled back to, so a failed task
   * leaves nothing behind while every task committed before it survives.
   */
  private async executeTask(
    project: Project,
    workflow: WorkflowDefinition,
    node: ForEachTaskStep,
    task: PlanTask,
    runId: string,
    signal: AbortSignal,
    pinnedInputs: ArtifactReference[],
  ): Promise<StoredArtifact> {
    const step = taskImplementStep(node.implement, task);
    const maxAttempts = node.implement.maxAttempts;
    await this.emit(project.id, 'task.started', `${task.id}: ${task.title}`, {
      nodeId: node.id,
      runId,
      dedupeKey: `${runId}:task:${node.id}:${task.id}:started`,
      data: {
        taskId: task.id,
        title: task.title,
        stepId: step.id,
        dependsOn: task.dependsOn,
        maxAttempts,
      },
    });
    const qualityAttemptStride = (node.browser ? 2 : 1) * ((node.repair?.maxAttempts ?? 0) + 1);
    const routing = resolveRoutingEntry(workflow.routing, workflow.id, step.taskKind);
    const resumedFailure = await this.resumedTaskFailure(
      project.id,
      runId,
      node.id,
      task.id,
      step.id,
      routing,
    );
    const taskCheckpoint =
      resumedFailure?.checkpoint ??
      (await this.workspaces.checkpoint(project.id, `${node.id}-${task.id}-${runId}`));
    const startAttempt =
      resumedFailure?.attempt ?? (await this.firstTaskAttempt(runId, node.id, step.id));
    let routingStartIndex = resumedFailure?.routingStartIndex ?? 0;
    if (resumedFailure?.checkpoint) {
      await this.workspaces.rollback(project.id, resumedFailure.checkpoint);
    }
    let lastError: unknown;
    try {
      for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
        await this.assertExecutionMayContinue(runId, signal);
        const qualityAttemptBase = (attempt - 1) * qualityAttemptStride;
        let implementation: StoredArtifact | undefined;
        try {
          const artifact = await this.executeStep(
            project,
            workflow,
            step,
            runId,
            node.id,
            signal,
            attempt,
            pinnedInputs,
            routingStartIndex,
          );
          implementation = artifact;
          const repaired = await this.verifyTask(
            project,
            workflow,
            node,
            task,
            artifact,
            runId,
            signal,
            pinnedInputs,
            qualityAttemptBase,
          );
          // Only once the checks are green: the assertion boots a preview, and a
          // preview of code that does not compile tells you nothing (#325).
          const asserted = await this.assertTask(
            project,
            workflow,
            node,
            task,
            runId,
            signal,
            pinnedInputs,
            qualityAttemptBase,
          );
          // A browser repair edited the workspace after the checks went green, so
          // they are no longer known to be. Re-run them, or a task could complete on
          // a red typecheck — the one thing ADR 0045 promises cannot happen. The
          // offset keeps this pass's step identities distinct from the first's.
          const reverified = asserted
            ? await this.verifyTask(
                project,
                workflow,
                node,
                task,
                asserted,
                runId,
                signal,
                pinnedInputs,
                qualityAttemptBase + (node.repair?.maxAttempts ?? 0) + 1,
              )
            : null;
          // The attempt behind the last artifact that changed the workspace is the
          // authority on what this task committed — the repair's, when one ran, not
          // the implementation it corrected. A task that changed nothing has no
          // commit at all.
          const commit = await this.commitForArtifact(
            runId,
            reverified ?? asserted ?? repaired ?? artifact,
          );
          const outcome = attempt > 1 ? ` (attempt ${attempt}/${maxAttempts})` : '';
          await this.emit(project.id, 'task.completed', `${task.id}: ${task.title}${outcome}`, {
            nodeId: node.id,
            runId,
            dedupeKey: `${runId}:task:${node.id}:${task.id}:completed`,
            data: {
              taskId: task.id,
              stepId: step.id,
              attempt,
              maxAttempts,
              ...(commit ? { commit } : {}),
              ...executorOutcome(artifact),
              artifact: artifact.metadata.name,
              revision: artifact.metadata.revision,
            },
          });
          return implementation;
        } catch (error) {
          if (!isTaskAttemptFailure(error, signal)) throw error;
          lastError = error;
          await this.emit(
            project.id,
            'task.failed',
            `${task.id} attempt ${attempt}/${maxAttempts} failed: ${errorMessage(error)}`,
            {
              nodeId: node.id,
              runId,
              dedupeKey: `${runId}:task:${node.id}:${task.id}:${attempt}:failed`,
              data: {
                taskId: task.id,
                stepId: step.id,
                attempt,
                maxAttempts,
                ...(await this.failedTaskExecutor(runId, node.id, step.id, attempt)),
              },
            },
          );
          if (!(error instanceof QualityGateError)) throw error;
          if (attempt >= maxAttempts) throw error;
          const nextRoutingStartIndex = nextTaskExecutorIndex(
            routing,
            implementation ? executorOutcome(implementation).executor : undefined,
            routingStartIndex,
          );
          if (nextRoutingStartIndex === undefined) {
            throw new ExecutionError(
              `Task ${task.id} exhausted its executor ladder after ${attempt} attempt(s): ${errorMessage(error)}`,
              { cause: error },
            );
          }
          routingStartIndex = nextRoutingStartIndex;
          await this.workspaces.rollback(project.id, taskCheckpoint);
        }
      }
      throw new ExecutionError(
        `Task ${task.id} failed after ${maxAttempts} attempt(s): ${errorMessage(lastError)}`,
      );
    } catch (error) {
      // Control flow — a pause, a cancellation — must keep what the task has
      // done so far; only a real failure discards it.
      if (isTaskAttemptFailure(error, signal)) {
        await this.workspaces.rollback(project.id, taskCheckpoint);
      }
      throw error;
    }
  }

  /** Resume a paused quality retry from the durable failed-attempt cursor. */
  private async resumedTaskFailure(
    projectId: string,
    runId: string,
    nodeId: string,
    taskId: string,
    stepId: string,
    routing: ReturnType<typeof resolveRoutingEntry>,
  ): Promise<{ attempt: number; routingStartIndex: number; checkpoint?: string } | undefined> {
    const terminal = (await this.events.list(projectId))
      .filter(
        (event) =>
          event.runId === runId &&
          event.nodeId === nodeId &&
          (event.type === 'task.failed' || event.type === 'task.completed') &&
          event.data.taskId === taskId &&
          event.data.stepId === stepId,
      )
      .at(-1);
    if (!terminal || terminal.type !== 'task.failed') return undefined;
    const failure = terminal;
    const failedAttempt = failure.data.attempt;
    if (typeof failedAttempt !== 'number') return undefined;

    const stepRun = (await this.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          candidate.iteration === failedAttempt &&
          !candidate.invalidatedAt,
      )
      .at(-1);
    if (!stepRun || stepRun.status !== 'completed') return undefined;

    const attempt = (await this.stepAttempts.list(runId, stepRun.id)).at(-1);
    if (!attempt || attempt.status !== 'succeeded') return undefined;

    const route = attempt.routeDecision?.routingTable;
    const consumedIndex = route
      ? route.executors.findIndex(
          (provider, index) => index >= route.selectedIndex && provider === attempt.provider,
        )
      : -1;
    let nextRoutingStartIndex = 0;
    if (route) {
      nextRoutingStartIndex = (consumedIndex >= 0 ? consumedIndex : route.selectedIndex) + 1;
    } else if (routing) {
      nextRoutingStartIndex =
        nextTaskExecutorIndex(routing, attempt.provider, 0) ?? routing.executors.length;
    }
    return {
      attempt: failedAttempt + 1,
      routingStartIndex: nextRoutingStartIndex,
      ...(attempt.checkpoint ? { checkpoint: attempt.checkpoint } : {}),
    };
  }

  /**
   * Every executor the failed attempt walked, in order, and the one it gave up
   * on (#326). Read back from the attempt records rather than threaded down,
   * because a step walks its whole candidate list before failing — "which
   * executors, after which failures" is exactly the record the ticket asks for,
   * and a failure is rare enough to afford the two reads.
   */
  private async failedTaskExecutor(
    runId: string,
    nodeId: string,
    stepId: string,
    iteration: number,
  ): Promise<{ executor?: string; modelId?: string; attemptedExecutors?: string[] }> {
    const stepRun = (await this.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          (candidate.iteration ?? 1) === iteration,
      )
      .at(-1);
    if (!stepRun) return {};
    const attempts = await this.stepAttempts.list(runId, stepRun.id);
    const last = attempts.at(-1);
    if (!last) return {};
    return {
      executor: last.provider,
      ...(last.modelId ? { modelId: last.modelId } : {}),
      attemptedExecutors: attempts.map((attempt) => attempt.provider),
    };
  }

  /**
   * The task's deterministic gate (#324). The checks run against the workspace
   * the implementation just left; a red report — never a reviewer's opinion —
   * is what invokes repair, and the report it carries holds the failing command
   * and its output. Exhausting `repair.maxAttempts` fails the task with the
   * checks still red, so nothing completes on a red check.
   *
   * Returns the last repair artifact, or null when the checks passed without
   * one — the caller needs it to report the commit the task actually ended on.
   */
  private async verifyTask(
    project: Project,
    workflow: WorkflowDefinition,
    node: ForEachTaskStep,
    task: PlanTask,
    implementation: StoredArtifact,
    runId: string,
    signal: AbortSignal,
    pinnedInputs: ArtifactReference[],
    iterationBase = 0,
  ): Promise<StoredArtifact | null> {
    const { verify, repair } = node;
    if (!verify || !repair) return null;
    const verifyStep = taskVerifyStep(verify, task);
    const repairStep = taskRepairStep(repair, task);
    const maxRepairAttempts = repair.maxAttempts;
    const startedAt = this.clock.now().getTime();
    let repaired: StoredArtifact | null = null;
    // A second pass over the same task needs its own iteration numbers, or it
    // would reuse the first pass's completed steps and read a stale report.
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.assertExecutionMayContinue(runId, signal);
      const report = await this.executeStep(
        project,
        workflow,
        verifyStep,
        runId,
        node.id,
        signal,
        iteration,
      );
      const parsed = VerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      // A deterministic verdict on the model that wrote the code, which is
      // what replaces the reviewer this node used to depend on.
      await this.recordQualityOutcome(implementation, approved);
      await this.qualityObservations?.recordDeterministic(implementation, report, approved);
      await this.appendDecisionLog(
        project.id,
        workflow.id,
        node.id,
        runId,
        implementation,
        approved,
        iteration,
        this.clock.now().getTime() - startedAt,
      );
      if (approved) {
        await this.resetConsecutiveRepairs(runId);
        await this.emit(project.id, 'quality.approved', `${task.id}: ${parsed.data.summary}`, {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:${iteration}:approved`,
          data: { taskId: task.id, stepId: verifyStep.id, iteration },
        });
        return repaired;
      }
      const summary = parsed.success
        ? parsed.data.summary
        : `${verifyStep.id} did not produce a verification report`;
      if (round > maxRepairAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed verification after ${maxRepairAttempts} repair attempt(s): ${summary}`,
          node.id,
        );
      }
      await this.emit(project.id, 'quality.repair_requested', `${task.id}: ${summary}`, {
        nodeId: node.id,
        runId,
        dedupeKey: `${runId}:task:${node.id}:${task.id}:${iteration}:repair_requested`,
        data: { taskId: task.id, stepId: repairStep.id, iteration, maxRepairAttempts },
      });
      // The report is pinned alongside the walk's own inputs, so repair reads
      // the exact revision that failed rather than whatever is latest.
      repaired = await this.executeStep(
        project,
        workflow,
        repairStep,
        runId,
        node.id,
        signal,
        iteration,
        [...pinnedInputs, artifactReference(report)],
      );
      await this.recordCompletedRepair(runId, node.id, repairStep.id, iteration, signal);
    }
  }

  /**
   * The task's browser assertion (#325). Typecheck passing does not mean the
   * feature works: the task's acceptance check becomes a declarative plan, the
   * existing Playwright runner asserts it against a live preview, and a failed
   * assertion reaches repair with the failing step and its captured evidence.
   *
   * Runs only once the deterministic checks are green, so the preview it boots
   * is built from code that already compiles. Returns the last repair artifact,
   * or null when nothing repaired — the caller needs it for the task's commit.
   */
  private async assertTask(
    project: Project,
    workflow: WorkflowDefinition,
    node: ForEachTaskStep,
    task: PlanTask,
    runId: string,
    signal: AbortSignal,
    pinnedInputs: ArtifactReference[],
    iterationBase = 0,
  ): Promise<StoredArtifact | null> {
    const { browser, repair } = node;
    if (!browser || !repair) return null;
    const planStep = taskBrowserPlanStep(browser.plan, task);
    const checkStep = taskBrowserCheckStep(browser.check, task);
    const repairStep = taskBrowserRepairStep(repair, browser, task);
    const maxRepairAttempts = repair.maxAttempts;

    await this.assertExecutionMayContinue(runId, signal);
    const plan = await this.executeStep(
      project,
      workflow,
      planStep,
      runId,
      node.id,
      signal,
      1,
      pinnedInputs,
    );
    // A task with no user-visible surface says so rather than inventing a
    // journey to assert. That is an answer, not a failure.
    const declared = AgentArtifactSchema.safeParse(plan.content);
    if (declared.success && declared.data.status === 'blocked') {
      await this.emit(
        project.id,
        'quality.approved',
        `${task.id}: no browser assertion — ${declared.data.summary}`,
        {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:skipped`,
          data: { taskId: task.id, stepId: planStep.id, asserted: false },
        },
      );
      return null;
    }

    if (!BrowserTestPlanArtifactSchema.safeParse(plan.content).success) {
      // Repairing the *code* cannot fix a malformed plan, and the plan is pinned
      // unchanged for every rerun — so retrying here would burn the whole repair
      // budget on something unfixable by construction.
      throw new ExecutionError(
        `Task ${task.id}: ${planStep.id} produced neither a valid browser test plan nor a "blocked" answer`,
      );
    }
    const planReference = artifactReference(plan);
    let repaired: StoredArtifact | null = null;
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.assertExecutionMayContinue(runId, signal);
      const report = await this.executeStep(
        project,
        workflow,
        checkStep,
        runId,
        node.id,
        signal,
        iteration,
        [planReference],
      );
      const parsed = BrowserVerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      if (approved) {
        // Same as the deterministic gate: a green result ends the streak, or
        // one browser repair per task would march the run into the
        // consecutive-repairs ceiling.
        await this.resetConsecutiveRepairs(runId);
        await this.emit(project.id, 'quality.approved', `${task.id}: ${parsed.data.summary}`, {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:${iteration}:approved`,
          data: { taskId: task.id, stepId: checkStep.id, iteration, asserted: true },
        });
        return repaired;
      }
      const failedStep = parsed.success
        ? parsed.data.steps.find((step) => step.status !== 'passed')
        : undefined;
      const summary = parsed.success
        ? parsed.data.summary
        : `${checkStep.id} did not produce a browser verification report`;
      if (round > maxRepairAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed its browser assertion after ${maxRepairAttempts} repair attempt(s): ${summary}`,
          node.id,
        );
      }
      await this.emit(project.id, 'quality.repair_requested', `${task.id}: ${summary}`, {
        nodeId: node.id,
        runId,
        dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:${iteration}:repair_requested`,
        data: {
          taskId: task.id,
          stepId: repairStep.id,
          iteration,
          maxRepairAttempts,
          ...(failedStep ? { failedStepId: failedStep.stepId } : {}),
        },
      });
      // The plan is pinned unchanged for the rerun, and the report carries the
      // failing step plus its screenshot/trace references.
      repaired = await this.executeStep(
        project,
        workflow,
        repairStep,
        runId,
        node.id,
        signal,
        iteration,
        [...pinnedInputs, planReference, artifactReference(report)],
      );
      await this.recordCompletedRepair(runId, node.id, repairStep.id, iteration, signal);
    }
  }

  /** The commit the attempt behind this artifact recorded, if it made one. */
  private async commitForArtifact(
    runId: string,
    artifact: StoredArtifact,
  ): Promise<string | undefined> {
    const { stepRunId, attemptId } = artifact.metadata;
    if (!stepRunId || !attemptId) return undefined;
    return (await this.stepAttempts.get(runId, stepRunId, attemptId))?.commit;
  }

  /**
   * Which attempt a replayed walk starts this task on. A completed attempt is
   * replayed at its own number so `executeStep` reuses it instead of
   * implementing and committing the task a second time; otherwise the walk
   * carries on after the attempts that already failed, so a pause never
   * refunds the bound.
   */
  private async firstTaskAttempt(runId: string, nodeId: string, stepId: string): Promise<number> {
    const previous = (await this.stepRuns.list(runId)).filter(
      (candidate) =>
        candidate.nodeId === nodeId && candidate.stepId === stepId && !candidate.invalidatedAt,
    );
    const completed = previous.find((candidate) => candidate.status === 'completed');
    if (completed) return completed.iteration ?? 1;
    return Math.max(0, ...previous.map((candidate) => candidate.iteration ?? 0)) + 1;
  }

  private async executeStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: ExecutableStep,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
    iteration?: number,
    pinnedArtifacts: ArtifactReference[] = [],
    routingStartIndex?: number,
  ): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': nodeId,
        'foundry.step.id': step.id,
        'foundry.step.type': step.type,
      },
      () =>
        this.executeStepTraced(
          project,
          workflow,
          step,
          runId,
          nodeId,
          signal,
          iteration,
          pinnedArtifacts,
          routingStartIndex,
        ),
    );
  }

  private async executeStepTraced(
    project: Project,
    workflow: WorkflowDefinition,
    step: ExecutableStep,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
    iteration?: number,
    pinnedArtifacts: ArtifactReference[] = [],
    routingStartIndex?: number,
  ): Promise<StoredArtifact> {
    throwIfCancelled(signal, runId);
    await this.assertExecutionMayContinue(runId, signal);
    const run = await this.requireRun(runId);
    // Pause only takes effect between steps: an in-flight step always
    // finishes (or fails) before the run parks.
    if (run.status === 'pause_requested') throw new RunPausedError(runId, nodeId);
    // Re-resolved every boundary so a mid-run policy edit blocks the next
    // step instead of silently governing it; the hash gate below proves the
    // copy used by this step is the one the run was pinned to.
    const policy = await this.policies.get(project.policyId);
    const currentHash = policyHash(policy);
    if (run.policy && run.policy.hash !== currentHash) {
      throw await this.policyChanged(project.id, runId, run.policy, policy, currentHash, nodeId);
    }

    const pinnedBrowserPlan =
      step.type === 'verify' && step.browserTestPlanArtifact
        ? pinnedArtifacts.find((artifact) => artifact.name === step.browserTestPlanArtifact)
        : undefined;
    const browserPlan =
      step.type === 'verify' && step.browserTestPlanArtifact
        ? pinnedBrowserPlan
          ? await this.loadArtifactReference(project.id, pinnedBrowserPlan)
          : await this.artifacts.getLatest(project.id, step.browserTestPlanArtifact)
        : null;
    if (step.type === 'verify' && step.browserTestPlanArtifact && !browserPlan) {
      throw new NotFoundError(`Missing input artifact(s): ${step.browserTestPlanArtifact}`);
    }
    let inputArtifacts =
      step.type === 'agent'
        ? await this.loadInputArtifacts(project.id, step.inputArtifacts, pinnedArtifacts)
        : browserPlan
          ? [browserPlan]
          : [];
    const directive = run.retry;
    const isRetryTarget =
      directive !== undefined &&
      directive.nodeId === nodeId &&
      directive.stepId === step.id &&
      (directive.iteration ?? null) === (iteration ?? null);
    if (isRetryTarget && directive.feedbackArtifact) {
      const feedbackReference = directive.feedbackArtifact;
      const feedback = await this.artifacts.getRevision(
        project.id,
        feedbackReference.name,
        feedbackReference.revision,
      );
      if (!feedback || feedback.metadata.sha256 !== feedbackReference.sha256) {
        throw new NotFoundError(
          `Feedback artifact ${feedbackReference.name} revision ${feedbackReference.revision} not found`,
        );
      }
      const alreadyLoaded = inputArtifacts.some(
        (artifact) =>
          artifact.metadata.name === feedbackReference.name &&
          artifact.metadata.revision === feedbackReference.revision &&
          artifact.metadata.sha256 === feedbackReference.sha256,
      );
      if (!alreadyLoaded) inputArtifacts = [...inputArtifacts, feedback];
    }
    const invalidatedByRetry =
      directive?.mode === 'invalidate' &&
      (await this.stepRuns.list(runId)).some(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === step.id &&
          (candidate.iteration ?? null) === (iteration ?? null) &&
          candidate.invalidatedAt,
      );
    const idempotencyKey = stepIdempotencyKey({
      runId,
      nodeId,
      step,
      iteration,
      inputs: inputArtifacts.map(artifactReference),
    });
    // Step identity stays input-derived so a completed retry remains reusable after its directive
    // is cleared; output writes add the retry generation so the retry still creates a new revision.
    const outputIdempotencyKey =
      isRetryTarget || invalidatedByRetry
        ? stepIdempotencyKey({
            runId,
            nodeId,
            step,
            iteration,
            retryRequestedAt: directive?.requestedAt,
            inputs: inputArtifacts.map(artifactReference),
          })
        : idempotencyKey;

    if (!isRetryTarget) {
      const reused = await this.reuseCompletedStep({
        project,
        step,
        runId,
        nodeId,
        iteration,
        idempotencyKey,
        outputIdempotencyKey,
        preserve: directive?.mode === 'preserve',
      });
      if (reused) {
        this.assertBlockingVerification(step, reused);
        return reused;
      }
    } else if (directive.checkpoint && step.type === 'agent' && step.mutatesWorkspace) {
      // A retried mutable step starts from the checkpoint its original
      // attempt recorded, not from whatever the workspace drifted to.
      await this.workspaces.rollback(project.id, directive.checkpoint);
    }

    const timestamp = this.clock.now().toISOString();
    let stepRun: StepRun = {
      id: this.ids.next(),
      runId,
      nodeId,
      stepId: step.id,
      stepType: step.type,
      ...(iteration ? { iteration } : {}),
      idempotencyKey,
      status: 'pending',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.stepRuns.create(stepRun);
    stepRun = await this.stepRuns.update(
      transitionStepRun(stepRun, 'running', this.clock.now()),
      stepRun.version,
    );
    await this.setCurrentStep(runId, stepRun, nodeId);

    try {
      const artifact =
        step.type === 'agent'
          ? await this.executeAgentStep(project, workflow, step, runId, stepRun, policy, signal, {
              inputArtifacts,
              idempotencyKey: outputIdempotencyKey,
              ...(isRetryTarget && directive.override ? { override: directive.override } : {}),
              ...(isRetryTarget && directive.override
                ? { overrideCreatedAt: directive.requestedAt }
                : {}),
              ...(iteration ? { iteration } : {}),
              ...(routingStartIndex !== undefined ? { routingStartIndex } : {}),
            })
          : await this.executeVerifyStep(
              project,
              workflow,
              step,
              runId,
              stepRun,
              policy,
              signal,
              outputIdempotencyKey,
              iteration,
              browserPlan ?? undefined,
            );
      this.assertBlockingVerification(step, artifact);
      stepRun = await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      await this.clearCurrentStep(runId);
      return artifact;
    } catch (error) {
      if (error instanceof LeaseLostError) throw error;
      if (stepRun.status === 'running') {
        const cancelled = isCancellation(error, signal);
        await this.stepRuns.update(
          transitionStepRun(
            stepRun,
            cancelled ? 'cancelled' : 'failed',
            this.clock.now(),
            cancelled ? {} : { error: runError(error) },
          ),
          stepRun.version,
        );
      }
      await this.syncProjectSummary(await this.requireRun(runId), nodeId);
      throw error;
    }
  }

  /**
   * Idempotent replay: when this step already completed under the same key
   * (or was explicitly preserved by a retry directive), reuse its artifact
   * instead of re-executing. Also recovers a walk that crashed between the
   * artifact write and the state write — the stale running records are
   * finalized against the orphaned artifact, and stale records without an
   * artifact are failed so the step re-executes cleanly.
   */
  private async reuseCompletedStep(input: {
    project: Project;
    step: ExecutableStep;
    runId: string;
    nodeId: string;
    iteration?: number | undefined;
    idempotencyKey: string;
    outputIdempotencyKey: string;
    preserve: boolean;
  }): Promise<StoredArtifact | null> {
    const {
      project,
      step,
      runId,
      nodeId,
      iteration,
      idempotencyKey,
      outputIdempotencyKey,
      preserve,
    } = input;
    const siblings = (await this.stepRuns.list(runId)).filter(
      (candidate) =>
        candidate.nodeId === nodeId &&
        candidate.stepId === step.id &&
        (candidate.iteration ?? null) === (iteration ?? null) &&
        !candidate.invalidatedAt,
    );

    const completed = siblings
      .filter(
        (candidate) =>
          candidate.status === 'completed' &&
          (candidate.idempotencyKey === idempotencyKey || preserve),
      )
      .at(-1);
    if (completed) {
      const artifact = await this.artifactForStepRun(project.id, runId, completed, step);
      if (artifact) {
        await this.emitStepReused(project.id, runId, nodeId, completed, artifact);
        return artifact;
      }
    }

    let adopted: StoredArtifact | null = null;
    for (const stale of siblings.filter((candidate) => candidate.status === 'running')) {
      const attempts = await this.stepAttempts.list(runId, stale.id);
      const running = attempts.filter((attempt) => attempt.status === 'running');
      const orphan: StoredArtifact | null =
        !adopted && stale.idempotencyKey === idempotencyKey
          ? await this.findArtifactByKey(project.id, step.outputArtifact, outputIdempotencyKey)
          : null;
      if (orphan) {
        this.assertBlockingVerification(step, orphan);
        const last = running.at(-1);
        if (last) {
          const commit =
            step.type === 'agent' && step.mutatesWorkspace
              ? await this.commitAgentWorkspace(project.id, step, last.checkpoint)
              : null;
          const succeeded = transitionStepAttempt(last, 'succeeded', this.clock.now(), {
            ...(commit ? { commit } : {}),
            outputArtifacts: [artifactReference(orphan)],
          });
          const completedAttempt = await this.stepAttempts.update(succeeded, last.version);
          if (commit && this.versions) {
            await this.versions.recordFromStep({
              projectId: project.id,
              runId,
              stepRunId: stale.id,
              attemptId: completedAttempt.id,
              commit,
            });
          }
        }
        for (const attempt of running.slice(0, -1)) {
          await this.failInterrupted(attempt);
        }
        const finalized = await this.stepRuns.update(
          transitionStepRun(stale, 'completed', this.clock.now()),
          stale.version,
        );
        await this.emitStepReused(project.id, runId, nodeId, finalized, orphan);
        adopted = orphan;
      } else {
        for (const attempt of running) {
          await this.failInterrupted(attempt);
        }
        await this.stepRuns.update(
          transitionStepRun(stale, 'failed', this.clock.now(), {
            error: {
              name: 'ExecutionError',
              message: 'Interrupted before completion; superseded by replay.',
            },
          }),
          stale.version,
        );
      }
    }
    return adopted;
  }

  private assertBlockingVerification(step: ExecutableStep, artifact: StoredArtifact): void {
    if (step.type !== 'verify' || !step.blocksOnFailure) return;
    const report = step.browserTestPlanArtifact
      ? BrowserVerificationReportSchema.parse(artifact.content)
      : VerificationReportSchema.parse(artifact.content);
    if (!report.approved) {
      throw new QualityGateError(
        `${step.id} failed blocking verification: ${report.summary}`,
        step.id,
      );
    }
  }

  private async commitAgentWorkspace(
    projectId: string,
    step: AgentStep,
    checkpoint?: string | null,
  ): Promise<string | null> {
    let commitError: unknown;
    let commitFailed = false;
    try {
      const commit = await this.workspaces.commit(projectId, `agent(${step.role}): ${step.title}`);
      if (commit) return commit;
    } catch (error) {
      commitError = error;
      commitFailed = true;
    }
    const head = await this.workspaces.head(projectId);
    if (checkpoint && head && head !== checkpoint) return head;
    if (commitFailed) throw commitError;
    return null;
  }

  private async failInterrupted(attempt: StepAttempt): Promise<void> {
    await this.stepAttempts.update(
      transitionStepAttempt(attempt, 'failed', this.clock.now(), {
        error: {
          name: 'ExecutionError',
          message: 'Interrupted before completion; superseded by replay.',
        },
      }),
      attempt.version,
    );
  }

  private async emitStepReused(
    projectId: string,
    runId: string,
    nodeId: string,
    stepRun: StepRun,
    artifact: StoredArtifact,
  ): Promise<void> {
    await this.emit(
      projectId,
      'step.reused',
      `${stepRun.stepId} reused ${artifact.metadata.name} r${artifact.metadata.revision}.`,
      {
        nodeId,
        runId,
        dedupeKey: `${runId}:step:${stepRun.id}:reused`,
        data: {
          stepRunId: stepRun.id,
          artifact: artifact.metadata.name,
          revision: artifact.metadata.revision,
        },
      },
    );
  }

  private async artifactForStepRun(
    projectId: string,
    runId: string,
    stepRun: StepRun,
    step: ExecutableStep,
  ): Promise<StoredArtifact | null> {
    const attempts = await this.stepAttempts.list(runId, stepRun.id);
    const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded').at(-1);
    if (!succeeded) return null;
    const reference =
      succeeded.outputArtifacts.find((output) => output.name === step.outputArtifact) ??
      succeeded.outputArtifacts[0];
    if (!reference) return null;
    return this.artifacts.getRevision(projectId, reference.name, reference.revision);
  }

  private async findArtifactByKey(
    projectId: string,
    name: string,
    idempotencyKey: string,
  ): Promise<StoredArtifact | null> {
    const metadata = await this.artifacts.listMetadata(projectId, name);
    const match = metadata.find((item) => item.idempotencyKey === idempotencyKey);
    return match ? this.artifacts.getRevision(projectId, name, match.revision) : null;
  }

  private async executeVerifyStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    policy: ProjectPolicy,
    signal: AbortSignal,
    idempotencyKey: string,
    iteration?: number,
    browserPlan?: StoredArtifact,
  ): Promise<StoredArtifact> {
    if (browserPlan) {
      return this.executeBrowserVerifyStep(
        project,
        workflow,
        step,
        runId,
        stepRun,
        policy,
        signal,
        idempotencyKey,
        browserPlan,
        iteration,
      );
    }
    const timestamp = this.clock.now().toISOString();
    const attempt: StepAttempt = {
      id: this.ids.next(),
      runId,
      stepRunId: stepRun.id,
      sequence: 1,
      executorKind: 'verification',
      provider: 'internal',
      model: 'workspace-verifier',
      context: {
        projectId: project.id,
        workflowId: workflow.id,
        nodeId: stepRun.nodeId,
        stepId: step.id,
        ...(iteration ? { iteration } : {}),
      },
      status: 'running',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      inputArtifacts: [],
      outputArtifacts: [],
    };
    await this.stepAttempts.create(attempt);
    return withSpan(
      'foundry.attempt',
      {
        'foundry.attempt.id': attempt.id,
        'foundry.attempt.sequence': attempt.sequence,
        'foundry.model.id': attempt.model,
        'foundry.provider': attempt.provider,
      },
      (span) =>
        this.executeVerifyStepAttempt(
          project,
          step,
          runId,
          stepRun,
          policy,
          signal,
          idempotencyKey,
          attempt,
          span,
        ),
    );
  }

  private async executeVerifyStepAttempt(
    project: Project,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    policy: ProjectPolicy,
    signal: AbortSignal,
    idempotencyKey: string,
    attempt: StepAttempt,
    span: Span,
  ): Promise<StoredArtifact> {
    const startedAt = Date.now();
    try {
      const report = await this.verifier.verify(
        {
          workspacePath: this.workspaces.workspacePath(project.id),
          scripts: step.scripts,
          autofixScripts: step.autofixScripts,
          optionalScripts: step.optionalScripts,
          includeGitDiffCheck: step.includeGitDiffCheck,
          policy,
        },
        signal,
      );
      throwIfCancelled(signal, runId);
      await this.assertExecutionMayContinue(runId, signal);
      if (report.approved) {
        const checkpoint = await this.workspaces.checkpoint(
          project.id,
          `${step.id}-${runId}-verified`,
        );
        await this.updateExecution(runId, (run) => ({
          ...(run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
          lastVerifiedCheckpoint: checkpoint,
        }));
      }
      const artifact = await this.artifacts.put({
        projectId: project.id,
        name: step.outputArtifact,
        content: report,
        createdBy: `verifier:${step.id}`,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        idempotencyKey,
      });
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: Date.now() - startedAt,
          outputArtifacts: [artifactReference(artifact)],
        }),
        attempt.version,
      );
      await this.emit(project.id, 'verification.completed', report.summary, {
        nodeId: step.id,
        runId,
        dedupeKey: `${runId}:attempt:${attempt.id}:verification.completed`,
        data: { approved: report.approved, attemptId: attempt.id },
      });
      await this.emitArtifactCreated(project.id, artifact, step.id, runId);
      return artifact;
    } catch (caught) {
      const error = await this.classifyFailure(runId, signal, caught);
      if (attempt.status === 'running') {
        const cancelled = isCancellation(error, signal);
        if (!cancelled) {
          // Reactive — the outcome wasn't known when the span started.
          // KeepErrorsSampler now records every span (never NOT_RECORD), so
          // this isn't a no-op on a non-recording span; TailSpanProcessor
          // reads the ERROR status/attribute at onEnd and exports
          // regardless of head sampling (see telemetry.ts).
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
          span.setAttribute('foundry.force_sample', true);
        }
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, cancelled ? 'cancelled' : 'failed', this.clock.now(), {
            durationMs: Date.now() - startedAt,
            ...(cancelled ? {} : { error: runError(error) }),
          }),
          attempt.version,
        );
      }
      throw error;
    }
  }

  private async executeBrowserVerifyStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    policy: ProjectPolicy,
    signal: AbortSignal,
    idempotencyKey: string,
    browserPlan: StoredArtifact,
    iteration?: number,
  ): Promise<StoredArtifact> {
    const browserVerification = this.browserVerification;
    if (!browserVerification) {
      throw new ExecutionError('Browser verification is not configured');
    }
    const timestamp = this.clock.now().toISOString();
    const planReference = artifactReference(browserPlan);
    const attempt: StepAttempt = {
      id: this.ids.next(),
      runId,
      stepRunId: stepRun.id,
      sequence: 1,
      executorKind: 'verification',
      provider: 'internal',
      model: 'browser-verifier',
      context: {
        projectId: project.id,
        workflowId: workflow.id,
        nodeId: stepRun.nodeId,
        stepId: step.id,
        ...(iteration ? { iteration } : {}),
      },
      status: 'running',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      inputArtifacts: [planReference],
      outputArtifacts: [],
    };
    await this.stepAttempts.create(attempt);
    return withSpan(
      'foundry.attempt',
      {
        'foundry.attempt.id': attempt.id,
        'foundry.attempt.sequence': attempt.sequence,
        'foundry.model.id': attempt.model,
        'foundry.provider': attempt.provider,
      },
      (span) =>
        this.executeBrowserVerifyStepAttempt(
          project,
          step,
          runId,
          stepRun,
          policy,
          signal,
          idempotencyKey,
          planReference,
          browserPlan,
          browserVerification,
          attempt,
          span,
        ),
    );
  }

  private async executeBrowserVerifyStepAttempt(
    project: Project,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    policy: ProjectPolicy,
    signal: AbortSignal,
    idempotencyKey: string,
    planReference: ArtifactReference,
    browserPlan: StoredArtifact,
    browserVerification: BrowserVerificationCoordinator,
    attempt: StepAttempt,
    span: Span,
  ): Promise<StoredArtifact> {
    const startedAt = Date.now();
    try {
      let artifact = await this.findArtifactByKey(project.id, step.outputArtifact, idempotencyKey);
      if (!artifact) {
        const report = await browserVerification.verify(
          {
            projectId: project.id,
            workspacePath: this.workspaces.workspacePath(project.id),
            runId,
            plan: browserPlan,
            allowedOrigins: policy.browserAllowedOrigins ?? [],
            evidencePolicy: policy.browserEvidence ?? DEFAULT_BROWSER_EVIDENCE_POLICY,
          },
          signal,
          async (previewSessionId) => {
            attempt = await this.stepAttempts.update(
              {
                ...attempt,
                previewSessionId,
                updatedAt: this.clock.now().toISOString(),
              },
              attempt.version,
            );
          },
        );
        throwIfCancelled(signal, runId);
        await this.assertExecutionMayContinue(runId, signal);
        artifact = await this.artifacts.put({
          projectId: project.id,
          name: step.outputArtifact,
          content: report,
          createdBy: `verifier:${step.id}`,
          runId,
          stepRunId: stepRun.id,
          attemptId: attempt.id,
          idempotencyKey,
        });
      }
      throwIfCancelled(signal, runId);
      await this.assertExecutionMayContinue(runId, signal);
      const sourceAttempt =
        artifact.metadata.stepRunId && artifact.metadata.attemptId
          ? await this.stepAttempts.get(
              runId,
              artifact.metadata.stepRunId,
              artifact.metadata.attemptId,
            )
          : null;
      if (!sourceAttempt?.previewSessionId) {
        throw new Error('Browser verification report is missing its source preview session.');
      }
      const persistedReport = validateBrowserVerificationReportBinding(artifact.content, {
        planArtifact: planReference,
        planContent: browserPlan.content,
        previewSessionId: sourceAttempt.previewSessionId,
      });
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: Date.now() - startedAt,
          outputArtifacts: [artifactReference(artifact)],
        }),
        attempt.version,
      );
      if (persistedReport.approved) {
        const checkpoint = await this.workspaces.checkpoint(
          project.id,
          `${step.id}-${runId}-verified`,
        );
        await this.updateExecution(runId, (run) => ({
          ...(run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
          lastVerifiedCheckpoint: checkpoint,
        }));
      }
      await this.emit(project.id, 'verification.completed', persistedReport.summary, {
        nodeId: step.id,
        runId,
        dedupeKey: `${runId}:attempt:${attempt.id}:verification.completed`,
        data: { approved: persistedReport.approved, attemptId: attempt.id },
      });
      await this.emitArtifactCreated(project.id, artifact, step.id, runId);
      return artifact;
    } catch (caught) {
      const error = await this.classifyFailure(runId, signal, caught);
      if (attempt.status === 'running') {
        const cancelled = isCancellation(error, signal);
        if (!cancelled) {
          // Reactive — the outcome wasn't known when the span started.
          // KeepErrorsSampler now records every span (never NOT_RECORD), so
          // this isn't a no-op on a non-recording span; TailSpanProcessor
          // reads the ERROR status/attribute at onEnd and exports
          // regardless of head sampling (see telemetry.ts).
          span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
          span.setAttribute('foundry.force_sample', true);
        }
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, cancelled ? 'cancelled' : 'failed', this.clock.now(), {
            durationMs: Date.now() - startedAt,
            ...(cancelled ? {} : { error: runError(error) }),
          }),
          attempt.version,
        );
      }
      throw error;
    }
  }

  private async executeAgentStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: AgentStep,
    runId: string,
    stepRun: StepRun,
    policy: ProjectPolicy,
    signal: AbortSignal,
    options: {
      inputArtifacts: StoredArtifact[];
      idempotencyKey: string;
      override?: RunRetryDirective['override'];
      overrideCreatedAt?: string;
      iteration?: number;
      routingStartIndex?: number;
    },
  ): Promise<StoredArtifact> {
    const {
      inputArtifacts,
      idempotencyKey,
      override,
      overrideCreatedAt,
      iteration: loopIteration,
      routingStartIndex,
    } = options;
    const harness = await this.harness.select({
      role: step.role,
      taskKind: step.taskKind,
      stack: workflow.stack,
      tags: step.harnessTags,
    });
    const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts, policy });
    const outputSchema =
      step.outputContract === 'task-graph'
        ? TASK_GRAPH_ARTIFACT_JSON_SCHEMA
        : workflowUsesBrowserPlan(workflow, step.outputArtifact)
          ? BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA
          : AGENT_ARTIFACT_JSON_SCHEMA;
    const explicit = await this.resolveModelPin(
      runId,
      stepRun.nodeId,
      step.id,
      override,
      overrideCreatedAt,
    );
    const providerHealth = this.executors
      ? new Map((await this.executors.health()).map((health) => [health.provider, health]))
      : undefined;
    // Only this layer knows which workflow is running, so it resolves the table
    // entry and the router just consumes it (#326).
    const routing = resolveRoutingEntry(workflow.routing, workflow.id, step.taskKind);
    const route = await this.router.route(profile, explicit, {
      ...(providerHealth ? { providerHealth } : {}),
      ...(routing ? { routing } : {}),
      ...(routingStartIndex !== undefined ? { routingStartIndex } : {}),
    });
    await this.emit(
      project.id,
      'agent.routed',
      `${step.id} routed to ${route.selected.model.id}.`,
      {
        nodeId: step.id,
        runId,
        dedupeKey: `${runId}:step:${stepRun.id}:routed`,
        data: {
          selected: route.selected.model.id,
          provider: route.selected.model.provider,
          fallbacks: route.fallbacks.map((candidate) => candidate.model.id),
          ...(route.routingTable
            ? {
                table: route.routingTable.source,
                executors: route.routingTable.executors,
                selectedIndex: route.routingTable.selectedIndex,
              }
            : {}),
          ...(route.override ? { override: route.override } : {}),
          ...(loopIteration ? { loopIteration } : {}),
        },
      },
    );

    // Explicit pins are already validated by the router.
    const candidates = explicit ? [route.selected] : [route.selected, ...route.fallbacks];
    const checkpoint = step.mutatesWorkspace
      ? await this.workspaces.checkpoint(project.id, `${step.id}-${runId}`)
      : null;
    if (checkpoint) {
      await this.emit(
        project.id,
        'git.checkpoint',
        `Checkpoint ${checkpoint.slice(0, 12)} created.`,
        {
          nodeId: step.id,
          runId,
          dedupeKey: `${runId}:checkpoint:${checkpoint}:${stepRun.id}`,
          data: { checkpoint },
        },
      );
    }

    let lastError: unknown;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate) continue;
      throwIfCancelled(signal, runId);
      if (index > 0) recordStepRetry();
      if (checkpoint && index > 0) await this.workspaces.rollback(project.id, checkpoint);

      const timestamp = this.clock.now().toISOString();
      const attempt: StepAttempt = {
        id: this.ids.next(),
        runId,
        stepRunId: stepRun.id,
        sequence: index + 1,
        executorKind: 'agent',
        provider: candidate.model.provider,
        model: candidate.model.model || candidate.model.id,
        modelId: candidate.model.id,
        status: 'running',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        ...(checkpoint ? { checkpoint } : {}),
        routeDecision: route,
        harness: {
          version: harness.version,
          files: harness.files.map((file) => ({ path: file.path, priority: file.priority })),
        },
        context: {
          projectId: project.id,
          workflowId: workflow.id,
          nodeId: stepRun.nodeId,
          stepId: step.id,
          ...(loopIteration ? { iteration: loopIteration } : {}),
        },
        inputArtifacts: inputArtifacts.map(artifactReference),
        outputArtifacts: [],
      };
      await this.stepAttempts.create(attempt);

      // A fallback candidate (index > 0) is already known to be a retry when
      // its span starts, so it's marked force_sample here for
      // RECORD_AND_SAMPLED at head-sampling time. An ordinary first-candidate
      // failure instead marks force_sample reactively (see
      // executeAgentAttempt's catch) once it's known to fail — that now
      // works too: KeepErrorsSampler records every span, so the reactive
      // write isn't a no-op, and TailSpanProcessor's export-time predicate
      // picks it up at onEnd regardless of the head-sampling outcome.
      const outcome = await withSpan(
        'foundry.attempt',
        {
          'foundry.attempt.id': attempt.id,
          'foundry.attempt.sequence': attempt.sequence,
          'foundry.model.id': candidate.model.id,
          'foundry.provider': candidate.model.provider,
          ...(index > 0 ? { 'foundry.force_sample': true } : {}),
        },
        (span) =>
          this.executeAgentAttempt(
            project,
            workflow,
            step,
            runId,
            stepRun,
            signal,
            checkpoint,
            candidate,
            candidates,
            index,
            attempt,
            route,
            harness,
            outputSchema,
            inputArtifacts,
            idempotencyKey,
            profile,
            span,
          ),
      );
      if (outcome.status === 'succeeded') return outcome.artifact;
      lastError = outcome.error;
    }

    if (checkpoint) await this.workspaces.rollback(project.id, checkpoint);
    throw lastError instanceof Error
      ? lastError
      : new ExecutionError(`All candidates failed for step ${step.id}`);
  }

  private async executeAgentAttempt(
    project: Project,
    workflow: WorkflowDefinition,
    step: AgentStep,
    runId: string,
    stepRun: StepRun,
    signal: AbortSignal,
    checkpoint: string | null,
    candidate: RankedModel,
    candidates: RankedModel[],
    index: number,
    initialAttempt: StepAttempt,
    route: RouteDecision,
    harness: HarnessSelection,
    outputSchema: Record<string, unknown>,
    inputArtifacts: StoredArtifact[],
    idempotencyKey: string,
    profile: TaskProfile,
    span: Span,
  ): Promise<
    { status: 'succeeded'; artifact: StoredArtifact } | { status: 'failed'; error: unknown }
  > {
    let attempt = initialAttempt;
    let requestMarkdown = '';
    const attemptStartedAt = Date.now();
    try {
      requestMarkdown = compileRequestMarkdown({
        projectId: project.id,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        workflowId: workflow.id,
        stack: workflow.stack,
        step,
        harness,
        artifacts: inputArtifacts,
        ...(step.taskKind === 'repair'
          ? {
              previewFailureEvents: [
                [...(await this.events.list(project.id))]
                  .reverse()
                  .find((event) => event.type === 'preview.failed'),
              ].filter((event): event is ProjectEvent => event !== undefined),
            }
          : {}),
        workspacePath: this.workspaces.workspacePath(project.id),
        toolPolicy: profile.toolPolicy,
      });
      await this.workspaces.writeRunContext({
        projectId: project.id,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        requestMarkdown,
        outputSchema,
      });
      const workspaceRef = checkpoint ?? (await this.workspaces.head(project.id)) ?? runId;
      const result = await this.executeCandidate(
        project,
        step,
        runId,
        stepRun.id,
        attempt.id,
        candidate,
        profile,
        signal,
        outputSchema,
        workspaceRef,
      );
      await this.assertExecutionMayContinue(runId, signal);
      if (step.outputContract === 'task-graph') {
        const graph = TaskGraphArtifactSchema.safeParse(result.output);
        if (!graph.success) {
          throw new Error(
            `Step ${step.id} must emit a task graph in data; output failed validation: ${formatZodIssues(graph.error, 'plan')}`,
          );
        }
      }
      const executionRoute: RouteDecision = {
        ...route,
        executed: candidate,
        attemptedModelIds: candidates.slice(0, index + 1).map((attempted) => attempted.model.id),
      };
      const artifact = await this.artifacts.put({
        projectId: project.id,
        name: step.outputArtifact,
        content: result.output,
        createdBy: `${step.role}:${candidate.model.provider}/${candidate.model.model || 'default'}`,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        routeDecision: executionRoute,
        idempotencyKey,
      });
      let commit: string | null = null;
      if (step.mutatesWorkspace) {
        try {
          commit = await this.commitAgentWorkspace(project.id, step, checkpoint);
        } catch (error) {
          attempt = await this.stepAttempts.update(
            transitionStepAttempt(attempt, 'failed', this.clock.now(), {
              durationMs: Date.now() - attemptStartedAt,
              error: runError(error),
              outputArtifacts: [artifactReference(artifact)],
            }),
            attempt.version,
          );
          throw error;
        }
      }
      const auditArtifact = await this.persistRunRecord(
        project.id,
        step,
        result,
        candidate.model.id,
        runId,
        stepRun.id,
        attempt.id,
        requestMarkdown,
        harness,
        inputArtifacts,
      );
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: result.durationMs,
          ...(result.executedModel ? { executedModel: result.executedModel } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(commit ? { commit } : {}),
          routeDecision: executionRoute,
          outputArtifacts: [artifactReference(artifact), artifactReference(auditArtifact)],
        }),
        attempt.version,
      );
      await this.appendDecisions(project.id, step, result.output, runId, stepRun.id, attempt.id);
      await this.emitArtifactCreated(project.id, artifact, step.id, runId);
      await this.emit(project.id, 'agent.completed', result.output.summary, {
        nodeId: step.id,
        runId,
        dedupeKey: `${runId}:attempt:${attempt.id}:completed`,
        data: {
          modelId: candidate.model.id,
          provider: candidate.model.provider,
          durationMs: result.durationMs,
          status: result.output.status,
          attemptId: attempt.id,
        },
      });
      if (commit && this.versions) {
        await this.versions.recordFromStep({
          projectId: project.id,
          runId,
          stepRunId: stepRun.id,
          attemptId: attempt.id,
          commit,
        });
      }
      return { status: 'succeeded', artifact };
    } catch (caught) {
      const error = await this.classifyFailure(runId, signal, caught);
      if (attempt.status !== 'running') throw error;
      if (isCancellation(error, signal)) {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'cancelled', this.clock.now(), {
            durationMs: Date.now() - attemptStartedAt,
          }),
          attempt.version,
        );
        if (checkpoint) await this.workspaces.rollback(project.id, checkpoint);
        throw error instanceof RunCancelledError ? error : new RunCancelledError(runId);
      }
      let failureArtifact: StoredArtifact | undefined;
      let failureRecordError: unknown;
      try {
        failureArtifact = await this.persistFailureRecord(
          project.id,
          step,
          runId,
          stepRun.id,
          attempt.id,
          index + 1,
          candidate.model.id,
          candidate.model.provider,
          error,
          Date.now() - attemptStartedAt,
          requestMarkdown,
          harness,
          inputArtifacts,
        );
      } catch (recordError) {
        failureRecordError = recordError;
      }
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'failed', this.clock.now(), {
          durationMs: Date.now() - attemptStartedAt,
          error: runError(error),
          ...(failureArtifact ? { outputArtifacts: [artifactReference(failureArtifact)] } : {}),
        }),
        attempt.version,
      );
      // Reactive — the outcome wasn't known when the span started.
      // KeepErrorsSampler now records every span (never NOT_RECORD), so this
      // isn't a no-op on a non-recording span; TailSpanProcessor reads the
      // ERROR status/attribute at onEnd and exports regardless of head
      // sampling (see telemetry.ts).
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
      span.setAttribute('foundry.force_sample', true);
      if (failureRecordError) throw failureRecordError;
      if (error instanceof EmergencyCeilingError) throw error;
      // An unauthenticated CLI never reached the model, so it says nothing about
      // the model's quality. Recording it would feed recentFailurePenalty in the
      // score router and consecutiveFailures in the circuit breaker, letting an
      // environment fault progressively deprioritise a perfectly good provider.
      if (!(error instanceof ProviderAuthenticationError)) {
        await this.metrics.record({
          modelId: candidate.model.id,
          taskKind: step.taskKind,
          role: step.role,
          taxonomyVersion: profile.taxonomyVersion,
          category: profile.category,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
        });
      }
      await this.emit(project.id, 'agent.failed', errorMessage(error), {
        nodeId: step.id,
        runId,
        data: {
          modelId: candidate.model.id,
          provider: candidate.model.provider,
          attempt: index + 1,
          attemptId: attempt.id,
        },
      });
      return { status: 'failed', error };
    }
  }

  private async resolveModelPin(
    runId: string,
    nodeId: string,
    stepId: string,
    retry?: RunRetryDirective['override'],
    retryCreatedAt?: string,
  ): Promise<ExplicitModelRoute | undefined> {
    if (retry) {
      let modelId = retry.modelId;
      if (!modelId) {
        const matches = (await this.router.catalog()).filter(
          (candidate) =>
            candidate.enabled &&
            candidate.provider === retry.provider &&
            candidate.model === retry.model,
        );
        if (matches.length !== 1) {
          throw new ExecutionError(
            `Legacy retry override ${retry.provider}/${retry.model} matched ${matches.length} enabled catalog models`,
          );
        }
        modelId = matches[0]!.id;
      }
      return {
        modelId,
        provider: retry.provider,
        model: retry.model,
        provenance: {
          source: 'retry',
          modelId,
          provider: retry.provider,
          model: retry.model,
          actor: retry.actor ?? { kind: 'system', id: 'legacy-retry' },
          reason: retry.reason ?? 'Legacy retry override without a recorded reason',
          estimatedImpact: retry.estimatedImpact ?? 'Not recorded in legacy retry directive',
          createdAt: retryCreatedAt ?? this.clock.now().toISOString(),
        },
      };
    }
    const overrides = (await this.modelOverrides?.list(runId)) ?? [];
    const match =
      overrides.find(
        (item) =>
          item.scope.kind === 'step' &&
          item.scope.nodeId === nodeId &&
          // A pin on a for-each-task node's implement step covers the per-task
          // ids it runs under; the operator pins the id the workflow declares.
          isTaskStepId(stepId, item.scope.stepId),
      ) ?? overrides.find((item) => item.scope.kind === 'run');
    if (!match) return undefined;
    return {
      modelId: match.modelId,
      provider: match.provider,
      model: match.model,
      provenance: {
        source: match.scope.kind,
        overrideId: match.id,
        modelId: match.modelId,
        provider: match.provider,
        model: match.model,
        actor: match.actor,
        reason: match.reason,
        estimatedImpact: match.estimatedImpact,
        createdAt: match.createdAt,
      },
    };
  }

  private async executeCandidate(
    project: Project,
    step: AgentStep,
    runId: string,
    stepRunId: string,
    attemptId: string,
    candidate: RankedModel,
    profile: TaskProfile,
    signal: AbortSignal,
    outputSchema: AgentExecutionRequest['outputSchema'],
    workspaceRef: string,
  ): Promise<AgentExecutionResult> {
    await this.emit(project.id, 'agent.started', `${step.id} started on ${candidate.model.id}.`, {
      nodeId: step.id,
      runId,
      dedupeKey: `${runId}:attempt:${attemptId}:started`,
      data: { modelId: candidate.model.id, provider: candidate.model.provider, attemptId },
    });
    const executionResult = await this.executionPlane.submit(
      {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: attemptId,
        agent: {
          runId,
          stepRunId,
          attemptId,
          projectId: project.id,
          stepId: step.id,
          role: step.role,
          taskKind: step.taskKind,
          provider: candidate.model.provider,
          model: candidate.model.model,
          prompt: compileCliPrompt(runId, stepRunId, attemptId),
          mutatesWorkspace: step.mutatesWorkspace,
          timeoutMs: this.options.agentTimeoutMs,
          outputSchema,
        },
        workspace: { projectId: project.id, ref: workspaceRef },
        // ponytail: tool allow-listing and network policy are shape-only until
        // v07-sandbox-runner/v07-network-policy/v07-secret-broker enforce them.
        tools: [],
        limits: { timeoutMs: this.options.agentTimeoutMs },
        networkPolicy: { mode: 'none', allowedHosts: [], purpose: 'execution' },
        secrets: this.secretStore
          ? (await this.secretStore.names(project.id)).map((name) => ({ name, ref: name }))
          : [],
      },
      signal,
      (event) =>
        persistStreamEvent(
          this.stepEvents,
          this.ids,
          this.clock,
          runId,
          stepRunId,
          attemptId,
          event,
        ),
    );
    // A result that arrives after cancellation was requested must never be promoted.
    throwIfCancelled(signal, runId);
    if (executionResult.state === 'cancelled') throw new RunCancelledError(runId);
    if (executionResult.state === 'failed' || !executionResult.agent) {
      const detail = executionResult.error;
      const ErrorType = detail?.kind === 'auth' ? ProviderAuthenticationError : ExecutionError;
      throw new ErrorType(detail?.message ?? 'Execution plane reported a failure', {
        ...(detail?.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail?.stdout !== undefined ? { stdout: detail.stdout } : {}),
        ...(detail?.stderr !== undefined ? { stderr: detail.stderr } : {}),
      });
    }
    const result = executionResult.agent;
    const estimatedCostUsd =
      result.usage && candidate.model.pricing
        ? calculateUsageCostUsd(result.usage, candidate.model.pricing)
        : undefined;
    const usage = result.usage
      ? {
          ...result.usage,
          ...(estimatedCostUsd !== undefined
            ? { estimatedCostUsd, sourceQuality: 'computed' as const }
            : {}),
        }
      : undefined;
    await this.metrics.record({
      modelId: candidate.model.id,
      taskKind: step.taskKind,
      role: step.role,
      taxonomyVersion: profile.taxonomyVersion,
      category: profile.category,
      success: true,
      durationMs: result.durationMs,
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(usage?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: usage.estimatedCostUsd }
        : {}),
      ...(usage?.cacheReadInputTokens !== undefined
        ? { cachedInputTokens: usage.cacheReadInputTokens }
        : {}),
      ...(usage?.quotaUnits !== undefined ? { quotaUnits: usage.quotaUnits } : {}),
    });
    if (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined) {
      recordTokenUsage({
        modelId: candidate.model.id,
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      });
    }
    return { ...result, ...(usage ? { usage } : {}) };
  }

  private async loadInputArtifacts(
    projectId: string,
    names: string[],
    pinnedArtifacts: ArtifactReference[] = [],
  ): Promise<StoredArtifact[]> {
    const artifacts = await Promise.all(
      names.map((name) => {
        const pinned = pinnedArtifacts.find((artifact) => artifact.name === name);
        return pinned
          ? this.loadArtifactReference(projectId, pinned)
          : this.artifacts.getLatest(projectId, name);
      }),
    );
    const missing = names.filter((_name, index) => artifacts[index] === null);
    if (missing.length) throw new NotFoundError(`Missing input artifact(s): ${missing.join(', ')}`);
    return artifacts.filter((artifact): artifact is StoredArtifact => artifact !== null);
  }

  private async loadArtifactReference(
    projectId: string,
    reference: ArtifactReference,
  ): Promise<StoredArtifact> {
    const artifact = await this.artifacts.getRevision(
      projectId,
      reference.name,
      reference.revision,
    );
    if (!artifact || artifact.metadata.sha256 !== reference.sha256) {
      throw new NotFoundError(
        `Artifact ${reference.name} revision ${reference.revision} not found`,
      );
    }
    return artifact;
  }

  private async recordQualityOutcome(artifact: StoredArtifact, approved: boolean): Promise<void> {
    const route = artifact.metadata.routeDecision;
    if (!route) return;
    const executed = route.executed ?? route.selected;
    await this.metrics.recordQuality({
      modelId: executed.model.id,
      taskKind: route.profile.taskKind,
      role: route.profile.role,
      taxonomyVersion: route.profile.taxonomyVersion,
      category: route.profile.category,
      approved,
    });
  }

  private async appendDecisionLog(
    projectId: string,
    workflowId: string,
    nodeId: string,
    runId: string,
    artifact: StoredArtifact,
    approved: boolean,
    iteration: number,
    durationMs: number,
  ): Promise<void> {
    if (!this.decisionLog) return;
    const route = artifact.metadata.routeDecision;
    if (!route) return;
    const executed = route.executed ?? route.selected;
    await this.decisionLog.append({
      schemaVersion: '1',
      id: this.ids.next(),
      routeId: route.routeId,
      createdAt: this.clock.now().toISOString(),
      projectId,
      runId,
      nodeId,
      workflowId,
      harnessVersion: await this.harness.version(),
      taskKind: route.profile.taskKind,
      category: route.profile.category,
      role: route.profile.role,
      provider: executed.model.provider,
      modelId: executed.model.id,
      model: executed.model.model,
      approved,
      firstPass: approved && iteration === 1,
      repairs: iteration - 1,
      durationMs,
      ...(executed.confidence
        ? { confidence: executed.confidence.value, sampleSize: executed.confidence.sampleSize }
        : {}),
    });
  }

  private async appendDecisions(
    projectId: string,
    step: AgentStep,
    output: AgentArtifact,
    runId: string,
    stepRunId: string,
    attemptId: string,
  ): Promise<void> {
    if (output.decisions.length === 0) return;
    const existing = await this.artifacts.getLatest(projectId, 'decision-log');
    const previous = isDecisionLog(existing?.content) ? existing.content.entries : [];
    const entries: DecisionLogEntry[] = [
      ...previous,
      ...output.decisions.map((decision) => ({
        recordedAt: this.clock.now().toISOString(),
        stepId: step.id,
        runId,
        stepRunId,
        attemptId,
        role: step.role,
        decision,
      })),
    ];
    const artifact = await this.artifacts.put({
      projectId,
      name: 'decision-log',
      content: { schemaVersion: '1', entries },
      createdBy: `orchestrator:${step.id}`,
      runId,
      stepRunId,
      attemptId,
    });
    await this.emitArtifactCreated(projectId, artifact, step.id, runId);
  }

  private async persistRunRecord(
    projectId: string,
    step: AgentStep,
    result: AgentExecutionResult,
    modelId: string,
    runId: string,
    stepRunId: string,
    attemptId: string,
    requestMarkdown: string,
    harness: HarnessSelection,
    inputArtifacts: StoredArtifact[],
  ): Promise<StoredArtifact> {
    return this.artifacts.put({
      projectId,
      name: `run-${attemptId}`,
      content: {
        schemaVersion: '1',
        stepId: step.id,
        role: step.role,
        taskKind: step.taskKind,
        modelId,
        provider: result.provider,
        model: result.model,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        usage: result.usage ?? null,
        inputs: inputArtifacts.map((artifact) => ({
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        })),
        harness: {
          version: harness.version,
          files: harness.files.map((file) => ({
            path: file.path,
            priority: file.priority,
            content: file.content,
          })),
        },
        requestMarkdown,
        stdout: result.stdout.slice(0, 50_000),
        stderr: result.stderr.slice(0, 50_000),
      },
      createdBy: 'orchestrator',
      runId,
      stepRunId,
      attemptId,
    });
  }

  private async persistFailureRecord(
    projectId: string,
    step: AgentStep,
    runId: string,
    stepRunId: string,
    attemptId: string,
    attempt: number,
    modelId: string,
    provider: string,
    error: unknown,
    durationMs: number,
    requestMarkdown: string,
    harness: HarnessSelection,
    inputArtifacts: StoredArtifact[],
  ): Promise<StoredArtifact> {
    const details = error instanceof ExecutionError ? error.details : {};
    return this.artifacts.put({
      projectId,
      name: `run-${attemptId}-failure`,
      content: {
        schemaVersion: '1',
        stepId: step.id,
        role: step.role,
        taskKind: step.taskKind,
        modelId,
        provider,
        attempt,
        durationMs,
        error: errorMessage(error),
        exitCode: details.exitCode ?? null,
        inputs: inputArtifacts.map(artifactReference),
        harness: {
          version: harness.version,
          files: harness.files.map((file) => ({
            path: file.path,
            priority: file.priority,
            content: file.content,
          })),
        },
        requestMarkdown: requestMarkdown.slice(0, 50_000),
        stdout: details.stdout?.slice(0, 50_000) ?? '',
        stderr: details.stderr?.slice(0, 50_000) ?? '',
      },
      createdBy: 'orchestrator',
      runId,
      stepRunId,
      attemptId,
    });
  }

  private async emitArtifactCreated(
    projectId: string,
    artifact: StoredArtifact,
    nodeId: string,
    runId?: string,
  ): Promise<void> {
    await this.emit(
      projectId,
      'artifact.created',
      `${artifact.metadata.name} revision ${artifact.metadata.revision} created.`,
      {
        nodeId,
        ...(runId ? { runId } : {}),
        dedupeKey: `${projectId}:artifact:${artifact.metadata.name}:r${artifact.metadata.revision}`,
        data: {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
      },
    );
  }

  private async createLegacyCompatibleRun(
    project: Project,
    workflowId: string,
    requestedRunId?: string,
  ): Promise<WorkflowRun> {
    const timestamp = this.clock.now().toISOString();
    const run: WorkflowRun = {
      id: requestedRunId ?? this.ids.next(),
      projectId: project.id,
      workflowId,
      status: 'queued',
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.runs.create(run);
    const updated: Project = {
      ...project,
      status: 'queued',
      currentRunId: run.id,
      updatedAt: timestamp,
    };
    delete updated.currentNodeId;
    delete updated.error;
    await this.projects.update(updated, project.version);
    return run;
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  private async setCurrentStep(
    runId: string,
    step: StepRun,
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal) throwIfCancelled(signal, runId);
    const run = await this.requireRun(runId);
    if (signal) throwIfCancelled(signal, runId);
    const updated = await this.runs.update(
      {
        ...run,
        currentStepRunId: step.id,
        updatedAt: this.clock.now().toISOString(),
      },
      run.version,
    );
    if (signal) throwIfCancelled(signal, runId);
    await this.syncProjectSummary(updated, nodeId);
  }

  private async clearCurrentStep(runId: string, signal?: AbortSignal): Promise<void> {
    if (signal) throwIfCancelled(signal, runId);
    const run = await this.requireRun(runId);
    if (signal) throwIfCancelled(signal, runId);
    const updated: WorkflowRun = { ...run, updatedAt: this.clock.now().toISOString() };
    delete updated.currentStepRunId;
    const saved = await this.runs.update(updated, run.version);
    if (signal) throwIfCancelled(signal, runId);
    await this.syncProjectSummary(saved);
  }

  private async syncProjectSummary(run: WorkflowRun, nodeId?: string): Promise<Project> {
    const project = await this.projects.get(run.projectId);
    if (!project) throw new NotFoundError(`Project ${run.projectId} not found`);
    let currentNodeId = nodeId;
    const currentStep = run.currentStepRunId
      ? await this.stepRuns.get(run.id, run.currentStepRunId)
      : null;
    if (!currentNodeId) currentNodeId = currentStep?.nodeId;
    const summaryError =
      run.error?.code === 'PROJECT_PROVISIONING_FAILED'
        ? PROVISIONING_FAILURE_MESSAGE
        : (run.error?.message ?? currentStep?.error?.message);
    const updated: Project = {
      ...project,
      status: projectStatusForRun(run),
      currentRunId: run.id,
      updatedAt: this.clock.now().toISOString(),
      ...(currentNodeId ? { currentNodeId } : {}),
      ...(summaryError ? { error: summaryError } : {}),
    };
    if (!currentNodeId) delete updated.currentNodeId;
    if (!summaryError) delete updated.error;
    return this.projects.update(updated, project.version);
  }

  private async emit(
    projectId: string,
    type: ProjectEvent['type'],
    message: string,
    options: {
      nodeId?: string;
      runId?: string;
      dedupeKey?: string;
      data?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    await this.events.append({
      id: this.ids.next(),
      projectId,
      type,
      createdAt: this.clock.now().toISOString(),
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      message,
      data: options.data ?? {},
    });
  }
}

/**
 * Shared by WorkflowOrchestrator and ConversationOperationRunner — both feed
 * the same executor onEvent callback into a StepEventRepository the same way.
 * Best-effort: a dropped live stream event never fails the run itself; the
 * final Message/Operation is still persisted normally.
 */
export function persistStreamEvent(
  stepEvents: StepEventRepository,
  ids: IdGenerator,
  clock: Clock,
  runId: string,
  stepRunId: string,
  attemptId: string,
  event: ExecutorStreamEvent,
): void {
  const input: AgentStreamEventInput = {
    id: ids.next(),
    runId,
    stepRunId,
    attemptId,
    createdAt: clock.now().toISOString(),
    ...event,
  };
  stepEvents.append(input).catch(() => undefined);
}

export function artifactReference(artifact: StoredArtifact) {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function workflowUsesBrowserPlan(workflow: WorkflowDefinition, artifactName: string): boolean {
  return workflow.nodes.some((node) => {
    if (node.type === 'verify') return node.browserTestPlanArtifact === artifactName;
    // A per-task assertion writes its plan through the node's browser step, so
    // that plan agent needs the same output schema (#325).
    if (node.type === 'for-each-task') {
      return node.browser?.check.browserTestPlanArtifact === artifactName;
    }
    if (node.type !== 'quality-loop') return false;
    return [node.setup, node.check].some(
      (step) => step?.type === 'verify' && step.browserTestPlanArtifact === artifactName,
    );
  });
}

/**
 * The implement step specialised to one task. The per-task id gives each task
 * its own StepRun, commit message, request folder and timeline entries; the
 * task's contract is appended to the instructions the workflow author wrote.
 */
function taskImplementStep(implement: AgentStep, task: PlanTask): AgentStep {
  return {
    ...implement,
    id: taskStepId(implement.id, task.id),
    title: `${task.id}: ${task.title}`,
    instructions: [
      implement.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Deliverables: ${task.deliverables.join(', ')}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      ...(task.dependsOn.length > 0 ? [`Depends on: ${task.dependsOn.join(', ')}`] : []),
      'Implement only this task. Earlier tasks are already implemented and committed in the workspace.',
    ].join('\n'),
  };
}

/**
 * The executor that produced this artifact, for the per-task outcome record
 * (#326). Reads the route decision the artifact already carries rather than
 * re-deriving it.
 */
function executorOutcome(artifact: StoredArtifact): { executor?: string; modelId?: string } {
  const route = artifact.metadata.routeDecision;
  if (!route) return {};
  const ran = route.executed ?? route.selected;
  return { executor: ran.model.provider, modelId: ran.model.id };
}

/** The task's deterministic gate, under the same per-task id rule. */
function taskVerifyStep(verify: VerifyStep, task: PlanTask): VerifyStep {
  return { ...verify, id: taskStepId(verify.id, task.id), title: `${task.id}: ${verify.title}` };
}

/**
 * The repair step specialised to one task. It is invoked only with a red
 * verification report in hand, so its instructions point at the failing
 * commands rather than at an opinion about the code.
 */
function taskRepairStep(repair: AgentStep, task: PlanTask): AgentStep {
  return {
    ...repair,
    id: taskStepId(repair.id, task.id),
    // Distinct from the implement step's title: it becomes the commit subject
    // (`agent(fixer): <taskId>: repair …`), and a repaired task therefore reads
    // as two commits that say what each of them did.
    title: `${task.id}: repair ${task.title}`,
    instructions: [
      repair.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      'Fix the root cause of every failing command in the verification report. Do not weaken or remove a check to make it pass.',
    ].join('\n'),
  };
}

/**
 * The step that turns one task's acceptance check into a browser plan (#325).
 * The check is prose the planner wrote; this is where it becomes a claim a
 * browser can settle.
 */
function taskBrowserPlanStep(plan: AgentStep, task: PlanTask): AgentStep {
  return {
    ...plan,
    id: taskStepId(plan.id, task.id),
    title: `${task.id}: ${plan.title}`,
    instructions: [
      plan.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check to assert: ${task.acceptanceCheck}`,
      `Deliverables: ${task.deliverables.join(', ')}`,
      'If this task has no user-visible surface to assert — a migration, a config change, a pure refactor — return status "blocked" with a one-line reason and no plan. That is a valid answer and does not fail the task.',
    ].join('\n'),
  };
}

/** The task's browser assertion, under the same per-task id rule. */
function taskBrowserCheckStep(check: VerifyStep, task: PlanTask): VerifyStep {
  return { ...check, id: taskStepId(check.id, task.id), title: `${task.id}: ${check.title}` };
}

/**
 * Repair for a failed browser assertion. It carries its own step id rather than
 * reusing the deterministic gate's, because both loops run for the same task and
 * would otherwise collide on step identity — and because a timeline that
 * distinguishes "the checks were red" from "the feature did not work" is worth
 * more than one that does not.
 */
function taskBrowserRepairStep(
  repair: AgentStep,
  browser: TaskBrowserAssertion,
  task: PlanTask,
): AgentStep {
  return {
    ...repair,
    id: taskStepId(browserRepairId(repair.id), task.id),
    // It reads what failed — the plan and the browser report — where the
    // declared repair step lists the deterministic gate's inputs instead.
    inputArtifacts: [
      ...new Set([
        ...repair.inputArtifacts,
        browser.plan.outputArtifact,
        browser.check.outputArtifact,
      ]),
    ],
    title: `${task.id}: repair browser assertion for ${task.title}`,
    instructions: [
      repair.instructions,
      '',
      `Task ${task.id}: ${task.title}`,
      `Acceptance check: ${task.acceptanceCheck}`,
      'The deterministic checks already pass; what failed is the browser assertion. Reproduce the failing step from the report and its evidence, fix the behaviour, and leave the plan unchanged for the rerun.',
    ].join('\n'),
  };
}

/**
 * Whether a task attempt may be retried: anything that is not the run's own
 * control flow (`isRunControlFlowError`, which lists those classes next to
 * their definitions) and not a cancellation the signal reports on its own.
 */
function isTaskAttemptFailure(error: unknown, signal: AbortSignal): boolean {
  return !isCancellation(error, signal) && !isRunControlFlowError(error);
}

function nextTaskExecutorIndex(
  routing: ReturnType<typeof resolveRoutingEntry>,
  provider: string | undefined,
  startIndex: number,
): number | undefined {
  if (!routing) return undefined;
  const consumedIndex = provider
    ? routing.executors.findIndex(
        (candidate, index) => index >= startIndex && candidate === provider,
      )
    : -1;
  const nextIndex = (consumedIndex >= 0 ? consumedIndex : startIndex) + 1;
  return nextIndex < routing.executors.length ? nextIndex : undefined;
}

function throwIfCancelled(signal: AbortSignal, runId: string): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof EmergencyCeilingError) throw signal.reason;
  if (signal.reason instanceof LeaseLostError) throw signal.reason;
  throw new RunCancelledError(runId);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof RunCancelledError ||
    (signal.aborted &&
      !(signal.reason instanceof EmergencyCeilingError) &&
      !(signal.reason instanceof LeaseLostError))
  );
}

export function runError(error: unknown): RunError {
  const details = error instanceof ExecutionError ? error.details : {};
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    ...(code ? { code } : {}),
    ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
  };
}

function projectStatusForRun(run: WorkflowRun): Project['status'] {
  if (run.status === 'queued') return 'queued';
  if (run.status === 'paused') return 'paused';
  if (run.status === 'awaiting_approval') return 'awaiting_approval';
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  if (run.status === 'rejected') return 'rejected';
  return 'running';
}

function isDecisionLog(
  value: unknown,
): value is { schemaVersion: '1'; entries: DecisionLogEntry[] } {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries);
}
