import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buffer } from 'node:stream/consumers';
import { join } from 'node:path';
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
  BrowserVerificationReport,
  ExecutableStep,
  ExecutorStreamEvent,
  ExecutorHealth,
  MigrationApproval,
  MigrationPreview,
  PreviewSession,
  PreviewFailurePhase,
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
  SchemaPlan,
  StepAttempt,
  StepRun,
  StoredArtifact,
  TaskProfile,
  UiQualityJudgeResult,
  VerifyStep,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
  ValidationCampaignExecution,
  ValidationCampaignPreview,
} from '@agent-foundry/contracts';
import {
  AGENT_ARTIFACT_JSON_SCHEMA,
  BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA,
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
  EXECUTION_PROTOCOL_VERSION,
  formatZodIssues,
  generateSchemaPlanSql,
  isWorkflowRunStatusTerminal,
  MigrationApprovalSchema,
  PROVISIONING_FAILURE_CONTEXT_MAX_BYTES,
  PROVISIONING_FAILURE_LOG_MAX_BYTES,
  ProvisioningFailureDiagnosticSchema,
  resolveRoutingEntry,
  SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA,
  SchemaPlanArtifactSchema,
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  UI_QUALITY_RUBRIC_V1,
  GeneratedTaskGraphArtifactSchema,
  createValidationCampaignExecution,
  VerificationReportSchema,
  ValidationDatabaseEvidenceSchema,
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
  SystemPromptRepository,
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
  MigrationApprovalRequiredError,
  NotFoundError,
  PolicyViolationError,
  ProviderAuthenticationError,
  ValidationCampaignLimitError,
  QualityGateError,
  RunCancelledError,
  RunPausedError,
  errorMessage,
  getValueAtPath,
  isRunControlFlowError,
  isTaskStepId,
  latestArtifactsByName,
  normalizeApprovalDecision,
  recordRunDuration,
  recordStepRetry,
  recordTokenUsage,
  redactString,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  VersionConflictError,
  withSpan,
  calculateUsageCostUsd,
} from '@agent-foundry/domain';
import {
  campaignLimitMs,
  summarizeValidationUsage,
  validationStepKey,
} from './validation-budget.js';
import type { PreviewService } from './preview-service.js';
import type { ProjectVersionService } from './project-version-service.js';
import { buildTaskProfile } from './task-profiler.js';
import {
  approvalGateIdempotencyKey,
  migrationApprovalGateId,
  policyHash,
  stepIdempotencyKey,
  workflowHash,
} from './idempotency.js';
import { compileCliPrompt, compileRequestMarkdown, isReviewerRole } from './prompt-compiler.js';
import { latestPreviewFailureEvent } from './preview-failure-lookup.js';
import {
  validateBrowserVerificationReportBinding,
  type BrowserVerificationCoordinator,
} from './browser-verification-coordinator.js';
import type { QualityObservationService } from './quality-observation-service.js';
import type { ValidationEvidencePublisher } from './validation-evidence.js';
import { TaskGraphRunner } from './task-graph-runner.js';
import { evaluateUiQuality, gateOnUiQuality } from './ui-quality-judge.js';

interface OrchestratorOptions {
  agentTimeoutMs: number;
  cancelPollIntervalMs: number;
  /** Concurrent plan tasks a for-each-task node may run (#520). Omitted means 1. */
  maxParallelTasks?: number;
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

class CancelledExecutionWithUsage extends RunCancelledError {
  constructor(
    runId: string,
    readonly usage: NonNullable<AgentExecutionResult['usage']>,
  ) {
    super(runId);
  }
}

const PROVISIONING_FAILURE_MESSAGE =
  'Project provisioning failed. Review the project event timeline for details.';

/** Bounds the UI-quality judge's prompt; the report schema caps it at 20. */
const UI_QUALITY_JUDGE_MAX_SCREENSHOTS = 10;

/**
 * The advisory judge gets its own, much shorter bound than a real agent step.
 * Reusing `agentTimeoutMs` would let a slow judge spend up to the full step
 * budget per browser-verify attempt, and `assertExecutionMayContinue` counts
 * that wall clock toward the run's active-time emergency ceiling — an
 * advisory annotation must not be able to move a ceiling, even indirectly.
 */
const UI_QUALITY_JUDGE_TIMEOUT_MS = 120_000;

function previewFailurePhase(code: string | undefined): PreviewFailurePhase | undefined {
  switch (code) {
    case 'PREVIEW_PREPARE_FAILED':
      return 'prepare';
    case 'PREVIEW_INSTALL_FAILED':
    case 'PREVIEW_START_FAILED':
      return 'start';
    case 'PREVIEW_UNHEALTHY':
      return 'health';
    case 'PREVIEW_RESTART_LIMIT':
    case 'PREVIEW_RESTART_FAILED':
      return 'runtime';
    default:
      return undefined;
  }
}

class ProjectProvisioningError extends Error {
  readonly code = 'PROJECT_PROVISIONING_FAILED';

  constructor(diagnostic: ProvisioningFailureDiagnostic) {
    super(`${diagnostic.summary}: ${diagnostic.context}`);
    this.name = 'ProjectProvisioningError';
  }
}

/** The slice of PreviewService that provisioning needs to boot a workspace. */
export type WorkspacePreviewBooter = Pick<PreviewService, 'start' | 'activeForProject'> &
  Partial<Pick<PreviewService, 'renewForProject' | 'stop'>>;

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
  const genericFailure = lines.find((line) =>
    /^(?:error running container(?::|\s).*|(?:supabase )?command failed\.?)$/i.test(line),
  );
  const contextCandidate =
    lines.find(
      (line) =>
        /error|fail|unable|unreachable|unhealthy|timeout|timed out|exit/i.test(line) &&
        line !== genericFailure,
    ) ??
    lines.find(
      (line) => line !== genericFailure && !/^(starting|initiali[sz]ing|stopping)\b/i.test(line),
    ) ??
    (genericFailure
      ? `${phaseLabel} could not start a service. No service-specific stderr was reported; inspect the bounded logs for the failing service before retrying provisioning.`
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
      const normalized = line
        .replace(/^(?:(?:stdout|stderr):\s*|\[(?:stdout|stderr)\]\s*)/i, '')
        .replace(/^(?:command failed|supabase command failed)(?::|\.)\s*/i, '');
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
  private readonly taskGraphRunner: TaskGraphRunner;

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
    private readonly executors?: Pick<ExecutorRegistry, 'health' | 'get'>,
    private readonly secretStore?: SecretStore,
    private readonly decisionLog?: RouterDecisionLogRepository,
    private readonly generatedProjectRuntime?: GeneratedProjectRuntime,
    private readonly previews?: WorkspacePreviewBooter,
    private readonly validationCampaign?: ValidationCampaignPreview,
    private readonly validationEvidence?: ValidationEvidencePublisher,
    private readonly systemPrompts?: SystemPromptRepository,
  ) {
    this.taskGraphRunner = new TaskGraphRunner({
      artifacts: this.artifacts,
      events: this.events,
      stepRuns: this.stepRuns,
      stepAttempts: this.stepAttempts,
      workspaces: this.workspaces,
      clock: this.clock,
      ids: this.ids,
      ...(options.maxParallelTasks !== undefined
        ? { maxParallelTasks: options.maxParallelTasks }
        : {}),
      runtime: {
        executeStep: (input) =>
          this.executeStep(
            input.project,
            input.workflow,
            input.step,
            input.runId,
            input.nodeId,
            input.signal,
            input.iteration,
            input.pinnedArtifacts ? [...input.pinnedArtifacts] : [],
            input.routingStartIndex,
            input.worktree,
          ),
        assertExecutionMayContinue: (runId, signal) =>
          this.assertExecutionMayContinue(runId, signal),
        isControlFlowError: (error, signal) =>
          isCancellation(error, signal) || isRunControlFlowError(error),
        recordDeterministicOutcome: async (input) => {
          await this.recordQualityOutcome(input.implementation, input.approved);
          await this.qualityObservations?.recordDeterministic(
            input.implementation,
            input.report,
            input.approved,
          );
          await this.appendDecisionLog(
            input.projectId,
            input.workflowId,
            input.nodeId,
            input.runId,
            input.implementation,
            input.approved,
            input.iteration,
            input.durationMs,
          );
        },
        recordCompletedRepair: (input) =>
          this.recordCompletedRepair(
            input.runId,
            input.nodeId,
            input.stepId,
            input.iteration,
            input.signal,
            input.scope,
          ),
        resetConsecutiveRepairs: (runId, scope) => this.resetConsecutiveRepairs(runId, scope),
      },
    });
  }

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
      const failurePhase = session.failurePhase ?? previewFailurePhase(session.error?.code);
      throw Object.assign(
        new Error(
          session.error?.message ??
            `Preview session ${session.id} reached '${session.status}' instead of 'running' while booting the workspace.`,
        ),
        {
          failurePhase,
          exitCode: session.failureEvidence?.exitCode ?? session.error?.exitCode,
          stdout: session.failureEvidence?.stdout,
          stderr: session.failureEvidence?.stderr,
        },
      );
    }
    return session;
  }

  /**
   * Terminates the preview this run booted once the run reaches a non-completed
   * terminal status (failed, cancelled, or rejected — #579), so it leaves
   * neither an orphan dev-server tree nor a session stuck at 'running'.
   * Completed runs keep their preview: the user is meant to browse the app
   * the run just built.
   */
  private async stopPreviewForFailedRun(projectId: string, runId: string): Promise<void> {
    const previews = this.previews;
    const stop = previews?.stop;
    if (!previews || !stop) return;
    const run = await this.runs.get(runId);
    if (!run || !isWorkflowRunStatusTerminal(run.status) || run.status === 'completed') return;
    const active = await previews.activeForProject(projectId);
    // A session booted by a different run is that run's to stop.
    if (!active || active.runId !== runId) return;
    try {
      await stop.call(previews, active.id);
    } catch (error) {
      await this.emit(
        projectId,
        'preview.cleanup_failed',
        'Preview cleanup failed; the lifecycle reaper will retry.',
        {
          runId,
          dedupeKey: `${runId}:preview.cleanup_failed`,
          data: {
            sessionId: active.id,
            error: redactString(errorMessage(error)).slice(0, 500),
          },
        },
      ).catch(() => undefined);
      throw error;
    }
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
    const stopPreviewLeaseHeartbeat = this.startPreviewLeaseHeartbeat(projectId);
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
      const activeRunId = run.id;
      const alreadyProvisioned = (await this.events.list(projectId)).some(
        (event) => event.runId === activeRunId && event.type === 'project.provisioned',
      );
      if ((this.generatedProjectRuntime || this.previews) && !alreadyProvisioned) {
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
        await this.finalizeApproval(run.id, projectId, error.nodeId, error.detail);
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
      const campaignLimitReached =
        error instanceof ValidationCampaignLimitError ||
        signal.reason instanceof ValidationCampaignLimitError;
      if (!campaignLimitReached) throwIfCancelled(signal, run.id);
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
      try {
        await this.publishTerminalEvidence(run.id);
      } finally {
        // Must not mask the run's real outcome (#579); a stuck-non-terminal
        // session still has the lifecycle reaper as its retry path.
        await this.stopPreviewForFailedRun(projectId, run.id).catch(() => undefined);
        stopPreviewLeaseHeartbeat();
        stopWatching();
      }
    }
  }

  private async publishTerminalEvidence(runId: string): Promise<void> {
    if (!this.validationEvidence) return;
    try {
      const run = await this.runs.get(runId);
      if (!run || !isWorkflowRunStatusTerminal(run.status)) return;
      await this.validationEvidence.publishFromRun(runId);
    } catch (error) {
      const run = await this.runs.get(runId).catch(() => undefined);
      if (run) {
        await this.emit(
          run.projectId,
          'validation.evidence_failed',
          'Validation evidence publication failed; the terminal run remains unchanged.',
          {
            runId,
            dedupeKey: `${runId}:validation.evidence_failed`,
            data: { error: redactString(errorMessage(error)).slice(0, 500) },
          },
        ).catch(() => undefined);
        if (run.status === 'cancelled') return;
      }
      // Preserve the terminal run state but let the queue retry evidence publication.
      throw error;
    }
  }

  private startPreviewLeaseHeartbeat(projectId: string): () => void {
    const previews = this.previews;
    const renew = previews?.renewForProject;
    if (!previews || !renew) return () => {};
    const timer = setInterval(() => {
      void renew.call(previews, projectId).catch(() => undefined);
    }, 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async startActiveExecution(runId: string): Promise<WorkflowRun> {
    return this.updateExecution(runId, (run, now) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      if (execution.ceiling) return execution;
      const activeSince = execution.activeSince ?? now.toISOString();
      const campaign = execution.campaign;
      const campaignSince = campaign?.activeSince ?? now.toISOString();
      if (execution.activeSince === activeSince && campaign?.activeSince === campaignSince) {
        return execution;
      }
      return {
        ...execution,
        activeSince,
        ...(campaign ? { campaign: { ...campaign, activeSince: campaignSince } } : {}),
      };
    });
  }

  private async stopActiveExecution(runId: string): Promise<WorkflowRun> {
    return this.updateExecution(runId, (run, now) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      const activeElapsedMs = execution.activeSince
        ? execution.activeElapsedMs + Math.max(0, now.getTime() - Date.parse(execution.activeSince))
        : execution.activeElapsedMs;
      const campaign = execution.campaign;
      const campaignElapsedMs = campaign?.activeSince
        ? campaign.activeElapsedMs + Math.max(0, now.getTime() - Date.parse(campaign.activeSince))
        : campaign?.activeElapsedMs;
      if (!execution.activeSince && campaign?.activeSince === undefined) return execution;
      const { activeSince: _activeSince, ...inactive } = execution;
      const nextCampaign = campaign
        ? {
            preview: campaign.preview,
            activeElapsedMs: campaignElapsedMs ?? campaign.activeElapsedMs,
            targetedRepairs: campaign.targetedRepairs,
          }
        : undefined;
      return {
        ...inactive,
        activeElapsedMs,
        ...(nextCampaign ? { campaign: nextCampaign } : {}),
      };
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
    this.assertCampaignMayContinue(run, signal);
  }

  private assertCampaignMayContinue(run: WorkflowRun, signal?: AbortSignal): void {
    const campaign = run.execution?.campaign;
    if (!campaign) return;
    if (signal) throwIfCancelled(signal, run.id);
    if (run.status === 'cancel_requested' || run.status === 'cancelled') {
      throw new RunCancelledError(run.id);
    }
    const activeElapsedMs =
      campaign.activeElapsedMs +
      (campaign.activeSince
        ? Math.max(0, this.clock.now().getTime() - Date.parse(campaign.activeSince))
        : 0);
    if (activeElapsedMs >= campaignLimitMs(campaign)) {
      throw new ValidationCampaignLimitError(run.id, 'active-time');
    }
  }

  private async assertCampaignUsageMayContinue(
    runId: string,
    currentAttempt?: StepAttempt,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    const campaign = run.execution?.campaign;
    if (!campaign) return;
    const attempts = await this.listRunAttempts(runId);
    const usage = summarizeValidationUsage(attempts);
    const providerHealth = this.executors
      ? new Map((await this.executors.health()).map((health) => [health.provider, health]))
      : undefined;
    const exceededSubscriptionQuota = Object.entries(usage.subscriptionQuotaUnitsByProvider).some(
      ([provider, quotaUnits]) => {
        const health = [...(providerHealth?.values() ?? [])].find(
          (health) => health.provider === provider,
        );
        const remaining = health?.rateLimit?.remaining;
        // Unknown metadata is not exhaustion (#418); only known evidence stops the run.
        if (remaining !== undefined && remaining <= 0) return true;
        return health?.rateLimit?.limit !== undefined && quotaUnits > health.rateLimit.limit;
      },
    );
    if (exceededSubscriptionQuota) {
      throw new ValidationCampaignLimitError(runId, 'subscription-quota');
    }
    const currentAttemptProvider = currentAttempt?.provider;
    const currentAttemptQuota = currentAttempt?.usage?.quotaUnits;
    if (currentAttemptProvider !== undefined && currentAttemptQuota !== undefined) {
      const remaining = [...(providerHealth?.values() ?? [])].find(
        (health) => health.provider === currentAttemptProvider,
      )?.rateLimit?.remaining;
      if (remaining === undefined || currentAttemptQuota > remaining) {
        throw new ValidationCampaignLimitError(runId, 'subscription-quota');
      }
    }
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
        error instanceof CancelledExecutionWithUsage &&
        (boundaryError instanceof RunCancelledError ||
          boundaryError instanceof ValidationCampaignLimitError)
      ) {
        return error;
      }
      if (
        boundaryError instanceof EmergencyCeilingError ||
        boundaryError instanceof RunCancelledError ||
        boundaryError instanceof ValidationCampaignLimitError
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
    scope?: string,
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
      if (countedRepairStepRunIds.includes(repair.id)) return execution;
      const counted = [...countedRepairStepRunIds, repair.id].slice(-10);
      if (scope === undefined) {
        return {
          ...execution,
          consecutiveRepairs: execution.consecutiveRepairs + 1,
          countedRepairStepRunIds: counted,
        };
      }
      // Under a parallel pool (#520) the run-level streak is the interleaving
      // of N independent repair ladders: eight tasks each needing two repairs
      // before their first approval reach 10 with no approval between them and
      // trip an emergency ceiling no single task came near, while one task's
      // approval zeroes a sibling that is genuinely running away. So the streak
      // is counted per task, and the flat field keeps the worst of them — which
      // leaves the ceiling check and every existing consumer untouched.
      const byTask = { ...(execution.consecutiveRepairsByTask ?? {}) };
      byTask[scope] = (byTask[scope] ?? 0) + 1;
      return {
        ...execution,
        consecutiveRepairs: Math.max(...Object.values(byTask)),
        consecutiveRepairsByTask: byTask,
        countedRepairStepRunIds: counted,
      };
    });
    if ((updated.execution?.consecutiveRepairs ?? 0) >= 10) {
      await this.reachCeiling(runId, 'consecutive-repairs', signal);
    }
  }

  private async resetConsecutiveRepairs(runId: string, scope?: string): Promise<void> {
    await this.updateExecution(runId, (run) => {
      const execution = run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      if (scope !== undefined) {
        // A scoped approval clears only its own task's streak; a sibling's
        // runaway keeps counting. `countedRepairStepRunIds` is left alone —
        // it is a replay-dedupe window over stepRun ids, not part of the
        // streak, and the ids in it are not attributable to a scope here.
        const byTask = { ...(execution.consecutiveRepairsByTask ?? {}) };
        if (!(scope in byTask)) return execution;
        delete byTask[scope];
        const remaining = Object.values(byTask);
        return {
          ...execution,
          consecutiveRepairs: remaining.length ? Math.max(...remaining) : 0,
          consecutiveRepairsByTask: byTask,
        };
      }
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

  private async listRunAttempts(runId: string): Promise<StepAttempt[]> {
    const steps = await this.stepRuns.list(runId);
    return (await Promise.all(steps.map((step) => this.stepAttempts.list(runId, step.id)))).flat();
  }

  private async reserveCampaignDispatch(input: {
    runId: string;
    nodeId: string;
    step: AgentStep;
    iteration?: number;
    candidate: RankedModel;
    providerHealth?: ReadonlyMap<string, ExecutorHealth>;
    sequence: number;
    targetedRetry: boolean;
    signal: AbortSignal;
  }): Promise<void> {
    const {
      runId,
      nodeId,
      step,
      iteration,
      candidate,
      providerHealth,
      sequence,
      targetedRetry,
      signal,
    } = input;
    const run = await this.requireRun(runId);
    this.assertCampaignMayContinue(run, signal);
    const campaign = run.execution?.campaign;
    if (!campaign) return;

    const attempts = await this.listRunAttempts(runId);
    const usage = summarizeValidationUsage(attempts);
    const key = validationStepKey(nodeId, step.id, iteration);
    const attemptsForStep = usage.attemptsByStep[key] ?? 0;
    const attemptLimit = campaign.preview.limits.attemptsPerAgentStep + (targetedRetry ? 1 : 0);
    if (attemptsForStep >= attemptLimit) {
      throw new ValidationCampaignLimitError(runId, 'attempts');
    }

    const isFirstRepairAttempt = step.taskKind === 'repair' && sequence === 1;
    const isTargetedRepair = targetedRetry || isFirstRepairAttempt;
    if (isTargetedRepair && campaign.targetedRepairs >= campaign.preview.limits.targetedRepairs) {
      throw new ValidationCampaignLimitError(runId, 'targeted-repairs');
    }

    const rateLimit = providerHealth?.get(candidate.model.provider)?.rateLimit;
    const usedQuota = usage.subscriptionQuotaUnitsByProvider[candidate.model.provider] ?? 0;
    // Unknown quota metadata stays unknown in the evidence; it is not a
    // synthetic exhausted-quota failure. CLI executors only learn their rate
    // limit from a previous execution's stdout, so failing closed here would
    // make the first subscription dispatch of every real campaign impossible
    // (#418). Only evidence of exhaustion stops the dispatch.
    if (
      (rateLimit?.remaining !== undefined && rateLimit.remaining <= 0) ||
      (rateLimit?.limit !== undefined && usedQuota >= rateLimit.limit)
    ) {
      throw new ValidationCampaignLimitError(runId, 'subscription-quota');
    }

    if (!isTargetedRepair) return;
    await this.updateExecution(runId, (latest) => {
      const latestCampaign = latest.execution?.campaign;
      if (!latestCampaign) return latest.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 };
      return {
        ...(latest.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
        campaign: { ...latestCampaign, targetedRepairs: latestCampaign.targetedRepairs + 1 },
      };
    });
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
        if (
          error instanceof EmergencyCeilingError ||
          error instanceof ValidationCampaignLimitError
        ) {
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

  private async finalizeApproval(
    runId: string,
    projectId: string,
    nodeId: string,
    detail?: string,
  ): Promise<void> {
    let run = await this.stopActiveExecution(runId);
    if (run.status === 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'awaiting_approval', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run, nodeId);
    const message = detail
      ? `Awaiting approval at ${nodeId}:\n${detail}`
      : `Awaiting approval at ${nodeId}.`;
    await this.emit(projectId, 'run.approval_requested', message, {
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

  // harnessVersion and systemPromptVersion are independent audit-trail
  // lookups (different repositories, different files) — run concurrently
  // rather than serially, and share the assembly logic between the two
  // call sites that record both.
  private async versionFields(): Promise<{
    harnessVersion: string;
    systemPromptVersion?: string;
  }> {
    const [harnessVersion, systemPromptVersion] = await Promise.all([
      this.harness.version(),
      this.systemPrompts?.version(),
    ]);
    return { harnessVersion, ...(systemPromptVersion ? { systemPromptVersion } : {}) };
  }

  private async pauseSnapshot(
    projectId: string,
    workflow: WorkflowDefinition,
    resumeNodeId?: string,
  ): Promise<RunPauseSnapshot> {
    const latest = latestArtifactsByName(await this.artifacts.listMetadata(projectId));
    return {
      workflowHash: workflowHash(workflow),
      ...(await this.versionFields()),
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
      return this.taskGraphRunner.run({ project, workflow, node, runId, signal });
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

    // An approved schema plan becomes a migration here, after the gate, so the
    // planning step that produced it never needs workspace-write and a rejected
    // plan leaves no DDL behind for a later run to apply (#481). Any other
    // gated artifact fails this parse and is left alone.
    const approvedSchemaPlan = SchemaPlanArtifactSchema.safeParse(reviewed.content);
    if (approvedSchemaPlan.success) {
      await this.writeSchemaPlanMigration(project.id, approvedSchemaPlan.data.data);
      throwIfCancelled(signal, runId);
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
      data: {
        action: decision.action,
        decidedBy: decision.decidedBy,
        artifact: artifactReference(artifact),
        reviewedArtifact: artifactReference(reviewed),
      },
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
    worktree?: string,
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
          worktree,
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
    worktree?: string,
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
        ...(worktree !== undefined ? { worktree } : {}),
      });
      if (reused) {
        this.assertBlockingVerification(step, reused);
        return reused;
      }
    } else if (directive.checkpoint && step.type === 'agent' && step.mutatesWorkspace) {
      // A retried mutable step starts from the checkpoint its original
      // attempt recorded, not from whatever the workspace drifted to. The
      // checkpoint was taken in *this* retry's `worktree`, which relies on
      // task-5 labels being derived from task id + run id: stable for the
      // whole run, so a retry lands in the same worktree as the attempt it
      // resumes. A label that varied per attempt would roll back the wrong
      // checkout here.
      await this.workspaces.rollback(project.id, directive.checkpoint, worktree);
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
              targetedRetry: isRetryTarget && directive?.mode === 'preserve',
              ...(worktree !== undefined ? { worktree } : {}),
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
              worktree,
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
    worktree?: string | undefined;
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
      worktree,
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
              ? await this.commitAgentWorkspace(project.id, step, last.checkpoint, worktree)
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

  /** Forward-only: an applied migration is never rewritten, so an unchanged
   * plan writes nothing and a changed one gets a new timestamped file. The
   * orchestrator commits it itself — the step that produced the plan is
   * read-only and has no commit of its own to ride on. */
  private async writeSchemaPlanMigration(projectId: string, plan: SchemaPlan): Promise<void> {
    const sql = generateSchemaPlanSql(plan);
    const dir = join(this.workspaces.workspacePath(projectId), 'supabase', 'migrations');
    await mkdir(dir, { recursive: true });
    const existing = (await readdir(dir))
      .filter((name) => name.endsWith('_schema_plan.sql'))
      .sort();
    const latestName = existing.at(-1);
    const latestContent = latestName ? await readFile(join(dir, latestName), 'utf8') : undefined;
    if (latestContent === sql) return;
    const timestamp = this.clock.now().toISOString().slice(0, 19).replace(/[-:T]/g, '');
    const filename = `${timestamp}_schema_plan.sql`;
    // Clock ticks are expected to separate two differing plans; a same-second
    // collision would otherwise silently clobber the prior migration in place.
    if (filename === latestName) {
      throw new Error(
        `Schema-plan migration ${filename} already exists with different content; the clock did not advance between two differing schema plans.`,
      );
    }
    await writeFile(join(dir, filename), sql);
    await this.workspaces.commit(projectId, `schema: approved schema plan migration ${filename}`);
  }

  private async commitAgentWorkspace(
    projectId: string,
    step: AgentStep,
    checkpoint?: string | null,
    worktree?: string,
  ): Promise<string | null> {
    let commitError: unknown;
    let commitFailed = false;
    try {
      const commit = await this.workspaces.commit(
        projectId,
        `agent(${step.role}): ${step.title}`,
        worktree,
      );
      if (commit) return commit;
    } catch (error) {
      commitError = error;
      commitFailed = true;
    }
    const head = await this.workspaces.head(projectId, worktree);
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
    worktree?: string,
  ): Promise<StoredArtifact> {
    if (browserPlan) {
      // Browser-visible acceptance drives a live preview session, which is
      // always booted from the primary checkout (bootWorkspacePreview) — so
      // the browser check itself stays on the primary checkout regardless of
      // which worktree the step that produced the plan ran in.
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
          worktree,
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
    worktree?: string,
  ): Promise<StoredArtifact> {
    const startedAt = Date.now();
    try {
      // The per-task browser check is the only other caller, and
      // task-graph-runner skips that step entirely for deterministic-only
      // tasks — so a plan without a single browser-visible task would never
      // apply the generated migration or notice drift at all (#481). The
      // blocking full-suite gate is the backstop that keeps a mismatch a hard
      // failure rather than a silent no-op.
      if (step.blocksOnFailure) {
        // `syncGeneratedDatabase` applies the *workspace's* pending migrations
        // to the one shared generated database and then checks it against the
        // approved schema plan. Both halves are run-level: it reads
        // `workspacePath(project.id)` with no worktree, so a worktree-scoped
        // blocking gate would verify against a database that never saw the
        // task's own migration — and threading the worktree in would be worse,
        // pushing one task's unmerged migration onto every sibling's database.
        // Refused loudly instead of silently wrong; today's `verify-task` in
        // web-app-v1.yaml does not set `blocksOnFailure`, so nothing hits this.
        if (worktree !== undefined) {
          throw new ExecutionError(
            `Verify step ${step.id} sets blocksOnFailure but is running in worktree "${worktree}": the generated database is shared across worktrees, so a per-task migration and schema check is not supported. Run the blocking gate on the primary checkout.`,
          );
        }
        await this.syncGeneratedDatabase(project, runId, stepRun.nodeId, signal);
      }
      const validationDatabaseGate =
        this.validationCampaign &&
        step.blocksOnFailure &&
        step.outputArtifact === 'verification.report';
      // 'smoke' asserts the scaffold's seeded turn-zero state, which only a
      // fresh db:start sandbox stack has; the gate queries the long-lived
      // runtime database where seed.sql never ran (#448).
      const optionalScripts = validationDatabaseGate
        ? step.optionalScripts?.filter(
            (script) => !['db:start', 'db:reset', 'smoke'].includes(script),
          )
        : step.optionalScripts;
      const beforeOptionalScripts = validationDatabaseGate
        ? [
            ...(step.optionalScripts?.includes('db:start') ? ['db:start'] : []),
            'database-row-match',
          ]
        : undefined;
      const validationRowTitleSha256 = await this.validationBrowserRowTitleSha256(project, runId);
      const validationRun = this.validationCampaign ? await this.runs.get(runId) : undefined;
      // The browser wrote its row to the long-lived project runtime database,
      // but db:start (run just before the row-match check) boots a fresh
      // ephemeral stack inside the workspace and overwrites .env with its
      // credentials — so the check queried an empty database and failed with
      // zero matches on every real campaign run. The script prefers process
      // env over .env; hand it the runtime credentials explicitly.
      const validationDatabaseSecrets =
        validationDatabaseGate && this.secretStore
          ? await this.secretStore.resolveAll(project.id)
          : undefined;
      const gateEnvironment: Record<string, string> = {
        ...(validationDatabaseSecrets?.NEXT_PUBLIC_SUPABASE_URL
          ? { NEXT_PUBLIC_SUPABASE_URL: validationDatabaseSecrets.NEXT_PUBLIC_SUPABASE_URL }
          : {}),
        ...(validationDatabaseSecrets?.SUPABASE_SERVICE_ROLE_KEY
          ? { SUPABASE_SERVICE_ROLE_KEY: validationDatabaseSecrets.SUPABASE_SERVICE_ROLE_KEY }
          : {}),
        ...(validationRowTitleSha256
          ? { AGENT_FOUNDRY_VALIDATION_ROW_TITLE_SHA256: validationRowTitleSha256 }
          : {}),
        ...(validationRowTitleSha256 && validationRun?.startedAt
          ? { AGENT_FOUNDRY_VALIDATION_RUN_STARTED_AT: validationRun.startedAt }
          : {}),
      };
      const report = await this.verifier.verify(
        {
          workspacePath: this.workspaces.workspacePath(project.id, worktree),
          scripts: step.scripts,
          autofixScripts: step.autofixScripts,
          optionalScripts,
          ...(Object.keys(gateEnvironment).length ? { environment: gateEnvironment } : {}),
          includeGitDiffCheck: step.includeGitDiffCheck,
          ...(beforeOptionalScripts ? { beforeOptionalScripts } : {}),
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
          worktree,
        );
        // lastVerifiedCheckpoint is a run-level field: the emergency-ceiling
        // draft (preserveDraft/rollback in WorkspaceManager) reads and resets
        // it entirely against the primary checkout, with no worktree
        // parameter of its own. A per-task worktree sha is not a valid value
        // for that field under any of its consumers — recording one would
        // point the draft branch and a ceiling rollback at unmerged,
        // eventually-gc'd task work instead of the primary's own history. So
        // a worktree-scoped verify simply doesn't advance the run's ceiling
        // anchor; the anchor keeps whatever the last primary-scoped verified
        // checkpoint was, exactly the pre-#520 meaning.
        if (worktree === undefined) {
          await this.updateExecution(runId, (run) => ({
            ...(run.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
            lastVerifiedCheckpoint: checkpoint,
          }));
        }
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
      const databaseArtifact = await this.persistValidationDatabaseEvidence(
        project,
        step,
        runId,
        stepRun,
        attempt,
        artifact,
        report,
      );
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: Date.now() - startedAt,
          outputArtifacts: [
            artifactReference(artifact),
            ...(databaseArtifact ? [artifactReference(databaseArtifact)] : []),
          ],
        }),
        attempt.version,
      );
      await this.emit(project.id, 'verification.completed', report.summary, {
        nodeId: step.id,
        runId,
        dedupeKey: `${runId}:attempt:${attempt.id}:verification.completed`,
        data: {
          approved: report.approved,
          attemptId: attempt.id,
          artifactName: step.outputArtifact,
          artifact: artifactReference(artifact),
        },
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

  private async persistValidationDatabaseEvidence(
    project: Project,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    attempt: StepAttempt,
    verificationArtifact: StoredArtifact,
    report: import('@agent-foundry/contracts').VerificationReport,
  ): Promise<StoredArtifact | undefined> {
    if (!this.validationCampaign || !step.blocksOnFailure) return undefined;
    let fingerprint: string | undefined;
    for (const command of report.commands) {
      if (command.name !== 'database-row-match' || command.skipped) continue;
      const match = command.stdout.match(/AGENT_FOUNDRY_DB_MATCH:([0-9a-f]{64})/i);
      if (match?.[1]) {
        fingerprint = match[1];
        break;
      }
    }
    if (!fingerprint) return undefined;
    const browserContext = await this.validationBrowserContext(project, runId);
    if (
      !browserContext?.sourceAttempt ||
      browserContext.sourceAttempt.status !== 'succeeded' ||
      !browserContext.sourceAttempt.previewSessionId ||
      !browserContext.sourceAttempt.outputArtifacts.some(
        (reference) =>
          reference.name === browserContext.browserArtifact.metadata.name &&
          reference.revision === browserContext.browserArtifact.metadata.revision &&
          reference.sha256 === browserContext.browserArtifact.metadata.sha256,
      )
    ) {
      return undefined;
    }
    const planArtifact = await this.artifacts.getRevision(
      project.id,
      browserContext.planReference.name,
      browserContext.planReference.revision,
    );
    if (!planArtifact) return undefined;
    try {
      validateBrowserVerificationReportBinding(browserContext.browserArtifact.content, {
        planArtifact: browserContext.planReference,
        planContent: planArtifact.content,
        previewSessionId: browserContext.sourceAttempt.previewSessionId,
      });
    } catch {
      return undefined;
    }
    const content = ValidationDatabaseEvidenceSchema.parse({
      schemaVersion: '1',
      status: 'matched',
      verification: 'create-list-reload',
      rowFingerprint: fingerprint,
      browserArtifact: artifactReference(browserContext.browserArtifact),
      verificationArtifact: artifactReference(verificationArtifact),
      checkedAt: this.clock.now().toISOString(),
    });
    const artifact = await this.artifacts.put({
      projectId: project.id,
      name: 'database.evidence',
      content,
      createdBy: `validation-evidence:${this.validationCampaign.id}`,
      runId,
      stepRunId: stepRun.id,
      attemptId: attempt.id,
      idempotencyKey: createHash('sha256')
        .update(
          JSON.stringify({
            runId,
            verificationArtifact: artifactReference(verificationArtifact),
            browserArtifact: artifactReference(browserContext.browserArtifact),
            fingerprint,
          }),
        )
        .digest('hex'),
    });
    await this.emitArtifactCreated(project.id, artifact, step.id, runId);
    return artifact;
  }

  private async validationBrowserRowTitleSha256(
    project: Project,
    runId: string,
  ): Promise<string | undefined> {
    const browserContext = await this.validationBrowserContext(project, runId);
    if (!browserContext) return undefined;
    const plan = await this.artifacts.getRevision(
      project.id,
      browserContext.planReference.name,
      browserContext.planReference.revision,
    );
    const parsedPlan = plan ? BrowserTestPlanArtifactSchema.safeParse(plan.content) : null;
    if (!parsedPlan?.success) return undefined;
    const fillValues = parsedPlan.data.data.steps
      .map((browserStep) => browserStep.action)
      .filter(
        (action): action is Extract<typeof action, { kind: 'fill' }> => action.kind === 'fill',
      )
      .map((action) => action.value);
    const rowTitle = fillValues.at(-1);
    return rowTitle ? createHash('sha256').update(rowTitle).digest('hex') : undefined;
  }

  private async validationBrowserContext(
    project: Project,
    runId: string,
  ): Promise<
    | {
        browserArtifact: StoredArtifact;
        sourceAttempt: StepAttempt | undefined;
        planReference: ArtifactReference;
      }
    | undefined
  > {
    if (!this.validationCampaign) return undefined;
    const browserArtifact = await this.artifacts.getLatest(
      project.id,
      'browser-verification.report',
    );
    if (!browserArtifact || browserArtifact.metadata.runId !== runId) return undefined;
    const { stepRunId, attemptId } = browserArtifact.metadata;
    const sourceAttempt =
      stepRunId && attemptId
        ? ((await this.stepAttempts.get(runId, stepRunId, attemptId)) ?? undefined)
        : undefined;
    const planReference = sourceAttempt?.inputArtifacts.find(
      (reference) => reference.name === 'browser-test.plan',
    );
    return planReference ? { browserArtifact, sourceAttempt, planReference } : undefined;
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

  /**
   * Task commits add supabase/migrations that only ever ran inside the verify
   * sandbox; the preview's API tier reads the long-lived project database, so
   * the schema must be applied there before a browser walks the app (#429:
   * "Could not find the table 'public.todos'"). The runtime copies new files
   * into its environment and applies pending migrations; a destructive
   * migration parks the run at an approval gate instead of failing it
   * outright (#535). Seed is deliberately not re-run: it is not idempotent,
   * and browser plans handle an empty state.
   *
   * It also owns the schema drift check (#481): once the migrations are
   * applied, the live database is compared against the approved
   * `schema.current` plan and any mismatch fails the step. Runs before the
   * browser check and before the blocking full-suite gate, so a plan whose
   * tasks are all deterministic-only is still checked.
   */
  private async syncGeneratedDatabase(
    project: Project,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.generatedProjectRuntime) return;
    await this.applyGeneratedMigrations(project, runId, nodeId, signal);
    // No artifact at all means a project that predates this check, or a
    // workflow without a schema step — nothing approved to verify against.
    const schemaArtifact = await this.artifacts.getLatest(project.id, 'schema.current');
    if (!schemaArtifact) return;
    const schemaPlan = SchemaPlanArtifactSchema.safeParse(schemaArtifact.content);
    if (!schemaPlan.success) return;
    const verification = await this.generatedProjectRuntime.verifySchema({
      projectId: project.id,
      tables: schemaPlan.data.data.tables,
    });
    const problems = [
      ...verification.missingTables.map((name) => `missing table "${name}"`),
      ...verification.missingColumns.map((name) => `missing column "${name}"`),
      ...verification.mismatchedColumns.map((detail) => `mismatched column ${detail}`),
      ...verification.tablesWithoutRls.map((name) => `RLS not enabled on "${name}"`),
      ...verification.missingPolicies.map((name) => `missing RLS policy "${name}"`),
    ];
    if (problems.length) {
      throw new ExecutionError(
        `Live database does not match the approved schema plan: ${problems.join(', ')}.`,
      );
    }
  }

  /**
   * Applies pending workspace migrations, parking the run at an approval
   * gate when the batch contains a destructive statement instead of letting
   * `applyWorkspaceMigrations` throw the run into `project.failed` (#535:
   * the gate existed in the platform layer but no caller ever wired it up).
   * Reused across the batch: the same `destructive` checksums keep failing
   * `applyWorkspaceMigrations` until an approval that covers all of them is
   * built and passed back in, so this recurses at most twice in practice
   * (once to discover the gate, once to apply with the resolved approval).
   */
  private async applyGeneratedMigrations(
    project: Project,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const workspaceMigrationsDir = join(
      this.workspaces.workspacePath(project.id),
      'supabase',
      'migrations',
    );
    try {
      await this.generatedProjectRuntime!.applyWorkspaceMigrations({
        projectId: project.id,
        workspaceMigrationsDir,
      });
    } catch (error) {
      if (!(error instanceof MigrationApprovalRequiredError)) throw error;
      const approval = await this.resolveMigrationApproval(
        project,
        runId,
        nodeId,
        signal,
        error.destructive,
      );
      // applyWorkspaceMigrations copies pending files into the runtime's
      // private workdir *before* migrate() can reject them (#535 simplify
      // review): they're already staged, so calling it again here would
      // find nothing left to copy and silently no-op instead of applying
      // the now-approved batch. migrate() with the resolved approval
      // applies directly; `migration up` covers every pending file
      // regardless of which single path is named.
      // ponytail: skips applyWorkspaceMigrations's #446 already-applied
      // reconcile retry for this one call — add here too if a destructive
      // migration ever needs it.
      await this.generatedProjectRuntime!.migrate({
        projectId: project.id,
        migrationPath: error.destructive.at(-1)!.migrationPath,
        approval,
      });
    }
  }

  /**
   * Parks the run at an approval gate for a destructive migration batch, the
   * way the `plan-approval` and `schema-approval` workflow nodes already do
   * (executeApprovalGateTraced) — reusing the same StepRun / ApprovalRequest
   * / ApprovalDecision machinery so decisions replay and resume identically.
   * The gate isn't a workflow-graph node (it fires mid-step, only when a
   * migration turns out destructive), so it's keyed off a synthetic node id
   * derived from the enclosing step instead of a static `node.id`.
   *
   * Resolves once an 'approve' decision is recorded, building a fresh backup
   * and MigrationApproval to hand back to the caller. Throws
   * ApprovalRequiredError while undecided and ApprovalRejectedError on
   * rejection — both already understood by the run loop's control-flow
   * handling (isRunControlFlowError) and by TaskGraphRunner's retry loop.
   */
  private async resolveMigrationApproval(
    project: Project,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
    destructive: MigrationPreview[],
  ): Promise<MigrationApproval> {
    const gateNodeId = migrationApprovalGateId(nodeId);
    throwIfCancelled(signal, runId);
    // requireMigrationApproval refuses the whole pending migration batch,
    // not just the destructive file(s) — say so, since an operator seeing
    // only the statements below would otherwise assume a clean sibling
    // migration in the same batch already went through (#535).
    const summary = [
      'This holds the entire pending migration batch, not just the file(s) below:',
      ...destructive.flatMap((preview) =>
        preview.destructiveStatements.map((statement) => `${preview.migrationPath}: ${statement}`),
      ),
    ].join('\n');

    let stepRun = (await this.stepRuns.list(runId)).find(
      (candidate) =>
        candidate.nodeId === gateNodeId &&
        candidate.stepId === gateNodeId &&
        !candidate.invalidatedAt,
    );
    throwIfCancelled(signal, runId);

    if (!stepRun) {
      const previewArtifact = await this.artifacts.put({
        projectId: project.id,
        name: 'migration.destructive-preview',
        content: { schemaVersion: '1', migrations: destructive },
        createdBy: `migration-approval:${gateNodeId}`,
        runId,
      });
      throwIfCancelled(signal, runId);
      const idempotencyKey = approvalGateIdempotencyKey({
        runId,
        nodeId: gateNodeId,
        artifact: artifactReference(previewArtifact),
      });

      const timestamp = this.clock.now().toISOString();
      stepRun = {
        id: this.ids.next(),
        runId,
        nodeId: gateNodeId,
        stepId: gateNodeId,
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
      await this.setCurrentStep(runId, stepRun, gateNodeId, signal);

      const approvalRequestId = this.ids.next();
      throwIfCancelled(signal, runId);
      const approvalRequest: ApprovalRequest = {
        id: approvalRequestId,
        runId,
        stepRunId: stepRun.id,
        nodeId: gateNodeId,
        artifact: artifactReference(previewArtifact),
        allowedActions: ['approve', 'reject'],
        createdAt: this.clock.now().toISOString(),
      };
      await this.approvalRequests.create(approvalRequest);
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
      throw new ApprovalRequiredError(runId, gateNodeId, summary);
    }

    const request = await this.approvalRequests.getForStepRun(runId, stepRun.id);
    throwIfCancelled(signal, runId);
    if (!request) {
      throw new ExecutionError(
        `Migration approval gate ${gateNodeId} has a pending StepRun but no ApprovalRequest`,
      );
    }
    const decision = normalizeApprovalDecision(await this.approvalDecisions.get(runId, request.id));
    throwIfCancelled(signal, runId);
    if (!decision) throw new ApprovalRequiredError(runId, gateNodeId, summary);
    if (decision.action === 'reject') {
      throw new ApprovalRejectedError(
        runId,
        gateNodeId,
        decision.decidedBy,
        decision.note ?? summary,
      );
    }
    if (decision.action !== 'approve') {
      // Only 'approve'/'reject' are ever offered (allowedActions above), so
      // this is an ApprovalAction variant this gate doesn't support rather
      // than a reachable 'request-changes' path.
      throw new ExecutionError(
        `Migration approval gate ${gateNodeId} decision '${decision.action}' is not supported`,
      );
    }

    const backup = await this.generatedProjectRuntime!.backupMigration({
      projectId: project.id,
      backupPath: `.foundry/migration-backups/${stepRun.id}.sql`,
    });
    throwIfCancelled(signal, runId);
    const [first, ...rest] = destructive;
    const approval = MigrationApprovalSchema.parse({
      migrationChecksum: first!.checksum,
      ...(rest.length ? { migrationChecksums: rest.map((preview) => preview.checksum) } : {}),
      backup,
    });

    if (stepRun.status !== 'completed') {
      await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      throwIfCancelled(signal, runId);
      await this.clearCurrentStep(runId, signal);
      throwIfCancelled(signal, runId);
      await this.emit(
        project.id,
        'run.approval_decided',
        `Migration approval at ${gateNodeId} approved.`,
        {
          nodeId: gateNodeId,
          runId,
          data: { decidedBy: decision.decidedBy },
        },
      );
    }
    return approval;
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
        await this.syncGeneratedDatabase(project, runId, stepRun.nodeId, signal);
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
        // Scores the evidence the verifier already captured. Advisory by
        // default (#475): an unconfigured or failing judge simply leaves
        // `uiQuality` off the persisted report. `gateOnUiQuality` below is
        // the one seam (#477, ADR 0058) where a configured
        // `policy.uiQualityJudge.minOverallScore` can flip `approved` to
        // false, so every downstream consumer of this artifact's `approved`
        // field routes through repair automatically.
        const uiQuality = await this.judgeUiQuality(
          project.id,
          runId,
          stepRun.id,
          attempt.id,
          step.id,
          policy,
          report,
          signal,
        );
        const gated = gateOnUiQuality(report, uiQuality, policy.uiQualityJudge?.minOverallScore);
        artifact = await this.artifacts.put({
          projectId: project.id,
          name: step.outputArtifact,
          content: uiQuality ? { ...gated, uiQuality } : gated,
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
        data: {
          approved: persistedReport.approved,
          attemptId: attempt.id,
          artifactName: step.outputArtifact,
          artifact: artifactReference(artifact),
        },
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
      targetedRetry?: boolean;
      worktree?: string;
    },
  ): Promise<StoredArtifact> {
    const {
      inputArtifacts,
      idempotencyKey,
      override,
      overrideCreatedAt,
      iteration: loopIteration,
      routingStartIndex,
      targetedRetry = false,
      worktree,
    } = options;
    const harness = await this.harness.select({
      role: step.role,
      taskKind: step.taskKind,
      stack: workflow.stack,
      tags: step.harnessTags,
    });
    const systemPrompt = (await this.systemPrompts?.select(step.role))?.content;
    const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts, policy });
    const outputSchema =
      step.outputContract === 'task-graph'
        ? TASK_GRAPH_ARTIFACT_JSON_SCHEMA
        : step.outputContract === 'schema-plan'
          ? SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA
          : workflowUsesBrowserPlan(workflow, step.outputArtifact)
            ? BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA
            : AGENT_ARTIFACT_JSON_SCHEMA;
    const run = await this.requireRun(runId);
    const campaign = run.execution?.campaign;
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
    const workflowRouting = resolveRoutingEntry(workflow.routing, workflow.id, step.taskKind);
    const campaignRoute = campaign?.preview.routes.find(
      (candidate) => candidate.taskKind === step.taskKind,
    );
    const campaignId = campaign?.preview.id;
    if (campaign && !campaignRoute) {
      throw new ExecutionError(
        `Validation campaign ${campaign.preview.id} has no route for task kind ${step.taskKind}`,
      );
    }
    const routing =
      campaignRoute && campaignId
        ? {
            source: `validation-campaign:${campaignId}`,
            executors: [
              campaignRoute.selected.provider,
              ...campaignRoute.fallbacks.map((candidate) => candidate.provider),
            ] as const,
          }
        : workflowRouting;
    const allowedModelIds = campaignRoute
      ? [campaignRoute.selected.id, ...campaignRoute.fallbacks.map((candidate) => candidate.id)]
      : undefined;
    const allowedModels = campaignRoute
      ? [campaignRoute.selected, ...campaignRoute.fallbacks]
      : undefined;
    const route = await this.router.route(profile, explicit, {
      ...(providerHealth ? { providerHealth } : {}),
      ...(routing ? { routing } : {}),
      ...(allowedModelIds && !explicit ? { allowedModelIds } : {}),
      ...(allowedModels && !explicit ? { allowedModels } : {}),
      ...(routingStartIndex !== undefined ? { routingStartIndex } : {}),
    });
    if (campaignRoute && !explicit) {
      const campaignModels = [campaignRoute.selected, ...campaignRoute.fallbacks];
      for (const candidate of [route.selected, ...route.fallbacks]) {
        const expected = campaignModels.find((model) => model.id === candidate.model.id);
        if (
          !expected ||
          expected.provider !== candidate.model.provider ||
          expected.model !== candidate.model.model
        ) {
          throw new ExecutionError(
            `Validation campaign ${campaignId} resolved an unapproved identity for model ${candidate.model.id}`,
          );
        }
      }
    }
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
      ? await this.workspaces.checkpoint(project.id, `${step.id}-${runId}`, worktree)
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
      if (checkpoint && index > 0) await this.workspaces.rollback(project.id, checkpoint, worktree);

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
      await this.reserveCampaignDispatch({
        runId,
        nodeId: stepRun.nodeId,
        step,
        ...(loopIteration !== undefined ? { iteration: loopIteration } : {}),
        candidate,
        ...(providerHealth ? { providerHealth } : {}),
        sequence: index + 1,
        targetedRetry,
        signal,
      });
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
            campaign,
            harness,
            systemPrompt,
            outputSchema,
            inputArtifacts,
            idempotencyKey,
            profile,
            span,
            worktree,
          ),
      );
      if (outcome.status === 'succeeded') return outcome.artifact;
      lastError = outcome.error;
    }

    if (checkpoint) await this.workspaces.rollback(project.id, checkpoint, worktree);
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
    campaign: ValidationCampaignExecution | undefined,
    harness: HarnessSelection,
    systemPrompt: string | undefined,
    outputSchema: Record<string, unknown>,
    inputArtifacts: StoredArtifact[],
    idempotencyKey: string,
    profile: TaskProfile,
    span: Span,
    worktree?: string,
  ): Promise<
    { status: 'succeeded'; artifact: StoredArtifact } | { status: 'failed'; error: unknown }
  > {
    let attempt = initialAttempt;
    let requestMarkdown = '';
    const attemptStartedAt = Date.now();
    try {
      const browserEvidence =
        step.taskKind === 'repair'
          ? await this.materializeBrowserEvidence(project.id, inputArtifacts)
          : { inputFiles: [], browserEvidenceStepIds: [] };
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
        browserEvidenceStepIds: browserEvidence.browserEvidenceStepIds,
        ...(step.taskKind === 'repair'
          ? {
              previewFailureEvents: [
                await latestPreviewFailureEvent(this.events, this.artifacts, project.id),
              ].filter((event): event is ProjectEvent => event !== undefined),
            }
          : {}),
        workspacePath: this.workspaces.workspacePath(project.id, worktree),
        toolPolicy: profile.toolPolicy,
      });
      await this.workspaces.writeRunContext(
        {
          projectId: project.id,
          runId,
          stepRunId: stepRun.id,
          attemptId: attempt.id,
          requestMarkdown,
          outputSchema,
          inputFiles: browserEvidence.inputFiles,
        },
        worktree,
      );
      const workspaceRef =
        checkpoint ?? (await this.workspaces.head(project.id, worktree)) ?? runId;
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
        systemPrompt,
        worktree,
      );
      if (result.usage || result.executedModel) {
        // Persist provider usage and executed identity while the attempt is
        // still running. A crash after the provider responds but before
        // artifact validation must not make a restart forget money or
        // subscription units already spent — and every way this attempt can
        // still fail below (campaign identity mismatch, artifact contract,
        // commit, budget cancellation) has to leave a trace that proves which
        // model actually ran, not just which one was requested (#562).
        attempt = await this.stepAttempts.update(
          {
            ...attempt,
            ...(result.usage ? { usage: result.usage } : {}),
            ...(result.executedModel ? { executedModel: result.executedModel } : {}),
            updatedAt: this.clock.now().toISOString(),
          },
          attempt.version,
        );
      }
      if (result.outputRepairs?.length) {
        // Emitted before the output-contract check below, so a repair stays
        // visible in the trace even when the contract validation then fails.
        await this.emit(
          project.id,
          'agent.output_repaired',
          `Structured output was repaired before validation: ${result.outputRepairs.join(', ')}.`,
          {
            nodeId: step.id,
            runId,
            dedupeKey: `${runId}:attempt:${attempt.id}:output-repaired`,
            data: {
              repairs: result.outputRepairs,
              modelId: candidate.model.id,
              provider: candidate.model.provider,
              attemptId: attempt.id,
            },
          },
        );
      }
      if (
        campaign &&
        (result.provider !== candidate.model.provider ||
          result.executedModel === undefined ||
          result.executedModel !== candidate.model.model)
      ) {
        throw new ExecutionError(
          `Validation campaign executed identity ${result.provider}/${result.executedModel ?? '<unknown>'} does not match ${candidate.model.provider}/${candidate.model.model}`,
        );
      }
      await this.assertCampaignUsageMayContinue(runId, attempt);
      await this.assertExecutionMayContinue(runId, signal);
      if (step.outputContract === 'task-graph') {
        const graph = GeneratedTaskGraphArtifactSchema.safeParse(result.output);
        if (!graph.success) {
          throw new Error(
            `Step ${step.id} must emit a task graph in data; output failed validation: ${formatZodIssues(graph.error, 'plan')}`,
          );
        }
      } else if (step.outputContract === 'schema-plan') {
        const schemaPlan = SchemaPlanArtifactSchema.safeParse(result.output);
        if (!schemaPlan.success) {
          throw new Error(
            `Step ${step.id} must emit a schema plan in data; output failed validation: ${formatZodIssues(schemaPlan.error, 'plan')}`,
          );
        }
        // The migration itself is written by the approval gate, not here: a
        // planning role must stay read-only, and a plan the operator rejects
        // must leave nothing behind (#481).
      }
      const executionRoute: RouteDecision = {
        ...route,
        executed: candidate,
        attemptedModelIds: candidates.slice(0, index + 1).map((attempted) => attempted.model.id),
      };
      const artifact = await this.artifacts.put({
        projectId: project.id,
        name: step.outputArtifact,
        content:
          campaign && step.outputArtifact === 'browser-test.plan'
            ? scopeValidationBrowserPlan(result.output, runId)
            : result.output,
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
          commit = await this.commitAgentWorkspace(project.id, step, checkpoint, worktree);
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
      if (error instanceof CancelledExecutionWithUsage && !attempt.usage) {
        attempt = await this.stepAttempts.update(
          { ...attempt, usage: error.usage, updatedAt: this.clock.now().toISOString() },
          attempt.version,
        );
      }
      const campaignLimitCancellation =
        error instanceof CancelledExecutionWithUsage &&
        signal.reason instanceof ValidationCampaignLimitError;
      if (campaignLimitCancellation) {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'failed', this.clock.now(), {
            durationMs: Date.now() - attemptStartedAt,
            error: runError(signal.reason),
          }),
          attempt.version,
        );
        if (checkpoint) await this.workspaces.rollback(project.id, checkpoint, worktree);
        throw signal.reason;
      }
      if (isCancellation(error, signal)) {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'cancelled', this.clock.now(), {
            durationMs: Date.now() - attemptStartedAt,
          }),
          attempt.version,
        );
        if (checkpoint) await this.workspaces.rollback(project.id, checkpoint, worktree);
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
      if (error instanceof ValidationCampaignLimitError) throw error;
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
          ...(retry.failedStep ? { failedStep: retry.failedStep } : {}),
          ...(retry.minimalReproducer ? { minimalReproducer: retry.minimalReproducer } : {}),
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
        ...(match.failedStep ? { failedStep: match.failedStep } : {}),
        ...(match.minimalReproducer ? { minimalReproducer: match.minimalReproducer } : {}),
        createdAt: match.createdAt,
      },
    };
  }

  /**
   * Materializes the failing steps' screenshots from a browser-verification
   * report into openable run-context files (#357). The report inlined into the
   * prompt only carries { name, revision, sha256 } references a CLI executor
   * cannot fetch; the returned files/paths make the evidence real for the
   * fixer. A blob that cannot be fetched is skipped; the request then states
   * explicitly that report-JSON references are unreachable identifiers.
   *
   * Also includes any screenshot named in `report.uiQuality.screenshotsReviewed`
   * (#477): a judge-only gate flips `approved` to false while every functional
   * step stays `passed`, so `failedStepIds` alone would hand the fixer zero
   * screenshots even though the judge's findings reference specific ones.
   */
  private async materializeBrowserEvidence(
    projectId: string,
    inputArtifacts: StoredArtifact[],
  ): Promise<{
    inputFiles: Array<{ path: string; content: Uint8Array }>;
    browserEvidenceStepIds: string[];
  }> {
    const report = inputArtifacts
      .filter((artifact) => artifact.metadata.name === 'browser-verification.report')
      .map((artifact) => BrowserVerificationReportSchema.safeParse(artifact.content))
      .find((parsed) => parsed.success)?.data;
    if (!report) return { inputFiles: [], browserEvidenceStepIds: [] };
    const failedStepIds = new Set(
      report.steps.filter((step) => step.status === 'failed').map((step) => step.stepId),
    );
    // Judge-reviewed screenshots (#477, see this function's JSDoc) are unioned
    // in unconditionally: a report can have both an unrelated advisory step
    // failure (`failedStepIds` non-empty, browser-verifier.ts's non-blocking
    // "advisory" signal) and a separate judge-caused rejection in the same
    // report, and each set names screenshots the other doesn't.
    const reviewedKeys = new Set(
      (report.uiQuality?.screenshotsReviewed ?? []).map((ref) => `${ref.name}@${ref.revision}`),
    );
    const screenshots = report.previewSession.evidence.screenshots.filter(
      (shot) => failedStepIds.has(shot.stepId) || reviewedKeys.has(`${shot.name}@${shot.revision}`),
    );
    const inputFiles: Array<{ path: string; content: Uint8Array }> = [];
    const browserEvidenceStepIds: string[] = [];
    for (const shot of screenshots) {
      const stream = await this.artifacts.getBlobStream(projectId, shot.name, shot.revision);
      if (!stream) continue;
      inputFiles.push({
        path: `browser-evidence/${shot.stepId}.png`,
        content: await buffer(stream),
      });
      browserEvidenceStepIds.push(shot.stepId);
    }
    return { inputFiles, browserEvidenceStepIds };
  }

  /**
   * Runs the advisory UI-quality judge over a browser-verification report's
   * screenshots (#475). Deliberately bypasses the routed agent pipeline —
   * no StepRun, StepAttempt, candidate ranking, or checkpoint — because the
   * judge is an annotation on an already-finished step, not a new stage in
   * the operation pipeline (ADR 0058). A project with no `uiQualityJudge`
   * policy never runs it; every failure degrades to `undefined`.
   */
  private async judgeUiQuality(
    projectId: string,
    runId: string,
    stepRunId: string,
    attemptId: string,
    stepId: string,
    policy: ProjectPolicy,
    report: BrowserVerificationReport,
    signal: AbortSignal,
  ): Promise<UiQualityJudgeResult | undefined> {
    const judge = policy.uiQualityJudge;
    if (!judge || !this.executors) return undefined;
    const screenshots = report.previewSession.evidence.screenshots.slice(
      0,
      UI_QUALITY_JUDGE_MAX_SCREENSHOTS,
    );
    if (screenshots.length === 0) return undefined;
    let cwd: string | undefined;
    try {
      cwd = await mkdtemp(join(tmpdir(), 'af-ui-quality-'));
      // The report inlines { name, revision, sha256 } references no executor
      // can fetch; the judge needs the bytes as real files under its cwd.
      const screenshotFiles: Array<{ stepId: string; localPath: string; ref: ArtifactReference }> =
        [];
      for (const [index, shot] of screenshots.entries()) {
        const stream = await this.artifacts.getBlobStream(projectId, shot.name, shot.revision);
        if (!stream) continue;
        const localPath = `${index}-${shot.stepId}.png`;
        await writeFile(join(cwd, localPath), await buffer(stream));
        screenshotFiles.push({ stepId: shot.stepId, localPath, ref: shot });
      }
      return await evaluateUiQuality({
        runId,
        stepRunId,
        attemptId,
        projectId,
        stepId,
        cwd,
        screenshotFiles,
        rubric: UI_QUALITY_RUBRIC_V1,
        executor: this.executors.get(judge.provider),
        provider: judge.provider,
        model: judge.model,
        timeoutMs: Math.min(this.options.agentTimeoutMs, UI_QUALITY_JUDGE_TIMEOUT_MS),
        signal,
      });
    } catch {
      return undefined;
    } finally {
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
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
    systemPrompt: string | undefined,
    worktree?: string,
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
          ...(candidate.model.reasoningEffort !== undefined
            ? { reasoningEffort: candidate.model.reasoningEffort }
            : {}),
          prompt: compileCliPrompt(runId, stepRunId, attemptId),
          mutatesWorkspace: step.mutatesWorkspace,
          timeoutMs: this.options.agentTimeoutMs,
          outputSchema,
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        },
        workspace: {
          projectId: project.id,
          ref: workspaceRef,
          ...(worktree !== undefined ? { worktree } : {}),
        },
        // ponytail: tool allow-listing is shape-only until v07-sandbox-runner/
        // v07-secret-broker enforce it.
        tools: [],
        limits: { timeoutMs: this.options.agentTimeoutMs },
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
    // Let the caller persist provider usage before cancellation prevents result promotion.
    if (executionResult.state === 'cancelled') {
      if (executionResult.agent?.usage) {
        throw new CancelledExecutionWithUsage(runId, executionResult.agent.usage);
      }
      throw new RunCancelledError(runId);
    }
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
      ...(await this.versionFields()),
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
        // Proof the stored output was validated, and against which contract (#563).
        outputValidation: {
          contract: step.outputContract ?? 'agent-artifact',
          repairs: result.outputRepairs ?? [],
        },
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
      ...(this.validationCampaign
        ? {
            execution: {
              activeElapsedMs: 0,
              consecutiveRepairs: 0,
              campaign: createValidationCampaignExecution(this.validationCampaign),
            },
          }
        : {}),
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

function scopeValidationBrowserPlan(content: unknown, runId: string): unknown {
  const parsed = BrowserTestPlanArtifactSchema.safeParse(content);
  if (!parsed.success) return content;
  const fillIndexes = parsed.data.data.steps.flatMap((step, index) =>
    step.action.kind === 'fill' ? [index] : [],
  );
  const fillIndex = fillIndexes.at(-1);
  const fillStep = fillIndex === undefined ? undefined : parsed.data.data.steps[fillIndex];
  if (fillIndex === undefined || !fillStep || fillStep.action.kind !== 'fill') return content;
  const originalValue = fillStep.action.value;
  const scopedValue = `${originalValue} [validation ${runId}]`;
  const rewriteLocator = <T extends { by: string; text?: string }>(locator: T): T =>
    locator.by === 'text' && locator.text === originalValue
      ? ({ ...locator, text: scopedValue } as T)
      : locator;
  return {
    ...parsed.data,
    data: {
      ...parsed.data.data,
      steps: parsed.data.data.steps.map((step, index) => ({
        ...step,
        ...(index === fillIndex ? { action: { ...step.action, value: scopedValue } } : {}),
        assertions: step.assertions.map((assertion) =>
          assertion.kind === 'containsText'
            ? {
                ...assertion,
                ...(assertion.expected === originalValue ? { expected: scopedValue } : {}),
                locator: rewriteLocator(assertion.locator),
              }
            : assertion,
        ),
      })),
    },
  };
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
function throwIfCancelled(signal: AbortSignal, runId: string): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof EmergencyCeilingError) throw signal.reason;
  if (signal.reason instanceof LeaseLostError) throw signal.reason;
  if (signal.reason instanceof ValidationCampaignLimitError) throw signal.reason;
  throw new RunCancelledError(runId);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof RunCancelledError ||
    (signal.aborted &&
      !(signal.reason instanceof EmergencyCeilingError) &&
      !(signal.reason instanceof LeaseLostError) &&
      !(signal.reason instanceof ValidationCampaignLimitError))
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
