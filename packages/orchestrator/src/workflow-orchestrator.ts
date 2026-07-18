import type {
  AgentArtifact,
  AgentExecutionRequest,
  AgentExecutionResult,
  AgentStep,
  ApprovalGateStep,
  ArtifactReference,
  ExecutableStep,
  Project,
  ProjectEvent,
  ProjectPolicy,
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
  BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
  EXECUTION_PROTOCOL_VERSION,
} from '@agent-foundry/contracts';
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  Clock,
  EventStore,
  ExecutionPlane,
  ExplicitModelRoute,
  HarnessRepository,
  HarnessSelection,
  IdGenerator,
  MetricsRepository,
  ModelRouter,
  ModelOverrideRepository,
  PolicyRepository,
  ProjectRepository,
  StepAttemptRepository,
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
  ExecutionError,
  NotFoundError,
  PolicyViolationError,
  RunCancelledError,
  RunPausedError,
  errorMessage,
  getValueAtPath,
  normalizeApprovalDecision,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  VersionConflictError,
} from '@agent-foundry/domain';
import type { ProjectVersionService } from './project-version-service.js';
import { buildTaskProfile } from './task-profiler.js';
import {
  approvalGateIdempotencyKey,
  policyHash,
  stepIdempotencyKey,
  workflowHash,
} from './idempotency.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';
import {
  validateBrowserVerificationReportBinding,
  type BrowserVerificationCoordinator,
} from './browser-verification-coordinator.js';

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

export class WorkflowOrchestrator {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly approvalRequests: ApprovalRequestRepository,
    private readonly approvalDecisions: ApprovalDecisionRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
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
  ) {}

  async runProject(projectId: string, workflowId?: string, requestedRunId?: string): Promise<void> {
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
    // A ceiling can crash after the terminal state write but before summary
    // sync or event append, so failed redelivery finishes those idempotently.
    if (run.status === 'failed' && run.execution?.ceiling) {
      await this.finalizeEmergencyCeiling(run.id, projectId);
      return;
    }
    if (
      run.status === 'cancelled' ||
      run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'rejected'
    )
      return;
    if (run.status === 'cancel_requested') {
      await this.finalizeCancellation(run.id, projectId);
      return;
    }
    if (run.status === 'pause_requested') {
      await this.finalizePause(run.id, projectId, workflow);
      return;
    }
    const cancellation = new AbortController();
    const stopWatching = this.watchForCancellation(run.id, cancellation);
    try {
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
      await this.assertExecutionMayContinue(run.id, cancellation.signal);
      await this.syncProjectSummary(run);
      await this.emit(projectId, 'project.started', `Workflow ${workflow.id} started.`, {
        runId: run.id,
        dedupeKey: `${run.id}:project.started`,
      });
      run = await this.enforceRunPolicy(run, project, workflow);
      for (const node of workflow.nodes) {
        throwIfCancelled(cancellation.signal, run.id);
        await this.assertExecutionMayContinue(run.id, cancellation.signal);
        await this.emit(projectId, 'node.started', node.title, {
          nodeId: node.id,
          runId: run.id,
          dedupeKey: `${run.id}:node:${node.id}:started`,
        });
        await this.executeNode(project, workflow, node, run.id, cancellation.signal);
        await this.emit(projectId, 'node.completed', node.title, {
          nodeId: node.id,
          runId: run.id,
          dedupeKey: `${run.id}:node:${node.id}:completed`,
        });
      }
      await this.assertExecutionMayContinue(run.id, cancellation.signal);
      run = await this.completeRun(run.id);
      await this.syncProjectSummary(run);
      // No dedupe key here: a terminal run early-returns on redelivery, and a
      // step retry legitimately completes the same run a second time.
      await this.emit(projectId, 'project.completed', `Workflow ${workflow.id} completed.`, {
        runId: run.id,
      });
    } catch (error) {
      if (error instanceof RunPausedError) {
        await this.finalizePause(run.id, projectId, workflow, error.nodeId);
        return;
      }
      if (error instanceof ApprovalRequiredError) {
        await this.finalizeApproval(run.id, projectId, error.nodeId);
        return;
      }
      if (error instanceof ApprovalRejectedError) {
        await this.finalizeRejection(run.id, projectId, error.nodeId, error.decidedBy);
        return;
      }
      if (isCancellation(error, cancellation.signal)) {
        await this.finalizeCancellation(run.id, projectId);
        return;
      }
      if (error instanceof EmergencyCeilingError) {
        const latest = await this.requireRun(run.id);
        if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
          await this.finalizeCancellation(run.id, projectId);
          return;
        }
        if (!(await this.finalizeEmergencyCeiling(run.id, projectId))) return;
        throw error;
      }
      const latest = await this.stopActiveExecution(run.id);
      if (latest.status === 'running' || latest.status === 'pause_requested') {
        run = await this.runs.update(
          transitionWorkflowRun(latest, 'failed', this.clock.now(), { error: runError(error) }),
          latest.version,
        );
      } else {
        run = latest;
      }
      await this.syncProjectSummary(run);
      await this.emit(projectId, 'project.failed', errorMessage(error), {
        runId: run.id,
      });
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

  private async completeRun(runId: string): Promise<WorkflowRun> {
    await this.stopActiveExecution(runId);
    await this.assertExecutionMayContinue(runId);
    for (;;) {
      const run = await this.requireRun(runId);
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        throw new RunCancelledError(runId);
      }
      if (run.execution?.ceiling) {
        throw new EmergencyCeilingError(runId, run.execution.ceiling.reason);
      }
      if (run.status === 'completed') return run;
      try {
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
      const { draftBranch } = draft;
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
            ceiling: { ...latest.execution!.ceiling!, draftBranch },
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
  ): Promise<void> {
    let run = await this.stopActiveExecution(runId);
    if (run.status === 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'rejected', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run, nodeId);
    await this.emit(projectId, 'run.rejected', `Rejected at ${nodeId} by ${decidedBy}.`, {
      runId,
      nodeId,
    });
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
    const metadata = await this.artifacts.listMetadata(projectId);
    const latest = new Map<string, { revision: number; sha256: string }>();
    for (const item of metadata) {
      const current = latest.get(item.name);
      if (!current || current.revision < item.revision) {
        latest.set(item.name, { revision: item.revision, sha256: item.sha256 });
      }
    }
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
    if (node.type === 'approval-gate') return this.executeApprovalGate(project, node, runId);
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
  ): Promise<StoredArtifact> {
    const reviewed = await this.artifacts.getLatest(project.id, node.artifact);
    if (!reviewed) throw new NotFoundError(`Missing input artifact(s): ${node.artifact}`);
    const idempotencyKey = approvalGateIdempotencyKey({
      runId,
      nodeId: node.id,
      artifact: artifactReference(reviewed),
    });

    const reused = await this.findArtifactByKey(project.id, node.outputArtifact, idempotencyKey);
    if (reused) return reused;

    let stepRun = (await this.stepRuns.list(runId)).find(
      (candidate) =>
        candidate.nodeId === node.id && candidate.stepId === node.id && !candidate.invalidatedAt,
    );

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
      stepRun = await this.stepRuns.update(
        transitionStepRun(stepRun, 'running', this.clock.now()),
        stepRun.version,
      );
      await this.setCurrentStep(runId, stepRun, node.id);

      const requestTimestamp = this.clock.now();
      const timeout =
        node.timeout.policy !== 'none' && node.timeout.afterMs !== undefined
          ? {
              timeout: { policy: node.timeout.policy, afterMs: node.timeout.afterMs },
              timeoutAt: new Date(requestTimestamp.getTime() + node.timeout.afterMs).toISOString(),
            }
          : {};
      await this.approvalRequests.create({
        id: this.ids.next(),
        runId,
        stepRunId: stepRun.id,
        nodeId: node.id,
        artifact: artifactReference(reviewed),
        allowedActions: node.actions,
        ...timeout,
        createdAt: requestTimestamp.toISOString(),
      });
      throw new ApprovalRequiredError(runId, node.id);
    }

    const request = await this.approvalRequests.getForStepRun(runId, stepRun.id);
    if (!request) {
      throw new ExecutionError(
        `Approval gate ${node.id} has a pending StepRun but no ApprovalRequest`,
      );
    }
    const decision = normalizeApprovalDecision(await this.approvalDecisions.get(runId, request.id));
    if (!decision) throw new ApprovalRequiredError(runId, node.id);

    if (decision.action === 'reject') {
      throw new ApprovalRejectedError(runId, node.id, decision.decidedBy);
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
    await this.stepRuns.update(
      transitionStepRun(stepRun, 'completed', this.clock.now()),
      stepRun.version,
    );
    await this.clearCurrentStep(runId);
    await this.emit(project.id, 'run.approval_decided', `${node.title} approved.`, {
      nodeId: node.id,
      runId,
      data: { action: decision.action, decidedBy: decision.decidedBy },
    });
    await this.emitArtifactCreated(project.id, artifact, node.id, runId);
    return artifact;
  }

  private async executeQualityLoop(
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
      if (qualitySubject) await this.recordQualityOutcome(qualitySubject, approved);
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
      if (reused) return reused;
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
      stepRun = await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      await this.clearCurrentStep(runId);
      return artifact;
    } catch (error) {
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
        const last = running.at(-1);
        if (last) {
          await this.stepAttempts.update(
            transitionStepAttempt(last, 'succeeded', this.clock.now(), {
              outputArtifacts: [artifactReference(orphan)],
            }),
            last.version,
          );
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
    let attempt: StepAttempt = {
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
    const startedAt = Date.now();
    try {
      const report = await this.verifier.verify(
        {
          workspacePath: this.workspaces.workspacePath(project.id),
          scripts: step.scripts,
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
        data: { approved: report.approved, attemptId: attempt.id },
      });
      await this.emitArtifactCreated(project.id, artifact, step.id, runId);
      return artifact;
    } catch (caught) {
      const error = await this.classifyFailure(runId, signal, caught);
      if (attempt.status === 'running') {
        const cancelled = isCancellation(error, signal);
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
    if (!this.browserVerification) {
      throw new ExecutionError('Browser verification is not configured');
    }
    const timestamp = this.clock.now().toISOString();
    const planReference = artifactReference(browserPlan);
    let attempt: StepAttempt = {
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
    const startedAt = Date.now();
    try {
      let artifact = await this.findArtifactByKey(project.id, step.outputArtifact, idempotencyKey);
      if (!artifact) {
        const report = await this.browserVerification.verify(
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
        data: { approved: persistedReport.approved, attemptId: attempt.id },
      });
      await this.emitArtifactCreated(project.id, artifact, step.id, runId);
      return artifact;
    } catch (caught) {
      const error = await this.classifyFailure(runId, signal, caught);
      if (attempt.status === 'running') {
        const cancelled = isCancellation(error, signal);
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
    },
  ): Promise<StoredArtifact> {
    const {
      inputArtifacts,
      idempotencyKey,
      override,
      overrideCreatedAt,
      iteration: loopIteration,
    } = options;
    const harness = await this.harness.select({
      role: step.role,
      taskKind: step.taskKind,
      stack: workflow.stack,
      tags: step.harnessTags,
    });
    const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts, policy });
    const outputSchema = workflowUsesBrowserPlan(workflow, step.outputArtifact)
      ? BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA
      : AGENT_ARTIFACT_JSON_SCHEMA;
    const explicit = await this.resolveModelPin(
      runId,
      stepRun.nodeId,
      step.id,
      override,
      overrideCreatedAt,
    );
    // ponytail: the router accepts RouteConstraints (provider rate limits + budget) but we do
    // not pass them yet — health() spawns a --version probe per provider, so a route-time
    // ProviderHealth snapshot needs a non-probing source first (v0.9 follow-up, issue #62).
    const route = await this.router.route(profile, explicit);
    await this.emit(
      project.id,
      'agent.routed',
      `${step.id} routed to ${route.selected.model.id}.`,
      {
        nodeId: step.id,
        runId,
        data: {
          selected: route.selected.model.id,
          provider: route.selected.model.provider,
          score: route.selected.score.total,
          fallbacks: route.fallbacks.map((candidate) => candidate.model.id),
          ...(route.override ? { override: route.override } : {}),
          ...(loopIteration ? { loopIteration } : {}),
        },
      },
    );

    // Explicit pins are already validated and scored by the router.
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
      if (checkpoint && index > 0) await this.workspaces.rollback(project.id, checkpoint);

      const timestamp = this.clock.now().toISOString();
      let attempt: StepAttempt = {
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
          workspacePath: this.workspaces.workspacePath(project.id),
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
        const commit = step.mutatesWorkspace
          ? await this.workspaces.commit(project.id, `agent(${step.role}): ${step.title}`)
          : null;
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
        return artifact;
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
        lastError = error;
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
        if (failureRecordError) throw failureRecordError;
        if (error instanceof EmergencyCeilingError) throw error;
        await this.metrics.record({
          modelId: candidate.model.id,
          taskKind: step.taskKind,
          role: step.role,
          taxonomyVersion: profile.taxonomyVersion,
          category: profile.category,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
        });
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
      }
    }

    if (checkpoint) await this.workspaces.rollback(project.id, checkpoint);
    throw lastError instanceof Error
      ? lastError
      : new ExecutionError(`All candidates failed for step ${step.id}`);
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
          item.scope.stepId === stepId,
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
        networkPolicy: { mode: 'none', allowedHosts: [] },
        secrets: [],
      },
      signal,
    );
    // A result that arrives after cancellation was requested must never be promoted.
    throwIfCancelled(signal, runId);
    if (executionResult.state === 'cancelled') throw new RunCancelledError(runId);
    if (executionResult.state === 'failed' || !executionResult.agent) {
      const detail = executionResult.error;
      throw new ExecutionError(detail?.message ?? 'Execution plane reported a failure', {
        ...(detail?.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail?.stdout !== undefined ? { stdout: detail.stdout } : {}),
        ...(detail?.stderr !== undefined ? { stderr: detail.stderr } : {}),
      });
    }
    const result = executionResult.agent;
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
      ...(result.usage?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: result.usage.estimatedCostUsd }
        : {}),
      ...(result.usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: result.usage.cachedInputTokens }
        : {}),
      ...(result.usage?.quotaUnits !== undefined ? { quotaUnits: result.usage.quotaUnits } : {}),
    });
    return result;
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

  private async setCurrentStep(runId: string, step: StepRun, nodeId: string): Promise<void> {
    const run = await this.requireRun(runId);
    const updated = await this.runs.update(
      {
        ...run,
        currentStepRunId: step.id,
        updatedAt: this.clock.now().toISOString(),
      },
      run.version,
    );
    await this.syncProjectSummary(updated, nodeId);
  }

  private async clearCurrentStep(runId: string): Promise<void> {
    const run = await this.requireRun(runId);
    const updated: WorkflowRun = { ...run, updatedAt: this.clock.now().toISOString() };
    delete updated.currentStepRunId;
    const saved = await this.runs.update(updated, run.version);
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
    const summaryError = run.error?.message ?? currentStep?.error?.message;
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
    if (node.type !== 'quality-loop') return false;
    return [node.setup, node.check].some(
      (step) => step?.type === 'verify' && step.browserTestPlanArtifact === artifactName,
    );
  });
}

function throwIfCancelled(signal: AbortSignal, runId: string): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof EmergencyCeilingError) throw signal.reason;
  throw new RunCancelledError(runId);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    error instanceof RunCancelledError ||
    (signal.aborted && !(signal.reason instanceof EmergencyCeilingError))
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
