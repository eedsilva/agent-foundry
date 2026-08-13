import type {
  AgentStep,
  ArtifactReference,
  ExecutableStep,
  ForEachTaskStep,
  PlanTask,
  Project,
  ProjectEvent,
  StoredArtifact,
  TaskBrowserAssertion,
  VerifyStep,
  WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  AgentArtifactSchema,
  BrowserTestPlanArtifactSchema,
  BrowserVerificationReportSchema,
  TaskGraphArtifactSchema,
  VerificationReportSchema,
  formatZodIssues,
  resolveRoutingEntry,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  IdGenerator,
  StepAttemptRepository,
  StepRunRepository,
  WorkspaceManager,
} from '@agent-foundry/domain';
import {
  AgentBlockedError,
  BrowserInfrastructureError,
  ExecutionError,
  NotFoundError,
  QualityGateError,
  browserRepairId,
  errorMessage,
  nextReadyTask,
  taskStepId,
  withSpan,
} from '@agent-foundry/domain';

export interface TaskGraphRunInput {
  project: Project;
  workflow: WorkflowDefinition;
  node: ForEachTaskStep;
  runId: string;
  signal: AbortSignal;
}

export interface TaskGraphStepExecution {
  project: Project;
  workflow: WorkflowDefinition;
  step: ExecutableStep;
  runId: string;
  nodeId: string;
  signal: AbortSignal;
  iteration?: number;
  pinnedArtifacts?: readonly ArtifactReference[];
  routingStartIndex?: number;
}

export interface TaskGraphRuntime {
  executeStep(input: TaskGraphStepExecution): Promise<StoredArtifact>;
  assertExecutionMayContinue(runId: string, signal: AbortSignal): Promise<void>;
  isControlFlowError(error: unknown, signal: AbortSignal): boolean;
  recordDeterministicOutcome(input: {
    projectId: string;
    workflowId: string;
    nodeId: string;
    runId: string;
    implementation: StoredArtifact;
    report: StoredArtifact;
    approved: boolean;
    iteration: number;
    durationMs: number;
  }): Promise<void>;
  recordCompletedRepair(input: {
    runId: string;
    nodeId: string;
    stepId: string;
    iteration: number;
    signal: AbortSignal;
  }): Promise<void>;
  resetConsecutiveRepairs(runId: string): Promise<void>;
}

export interface TaskGraphRunnerDependencies {
  artifacts: Pick<ArtifactStore, 'getLatest' | 'getRevision'>;
  events: Pick<EventStore, 'append' | 'list'>;
  stepRuns: Pick<StepRunRepository, 'list'>;
  stepAttempts: Pick<StepAttemptRepository, 'get' | 'list'>;
  workspaces: Pick<WorkspaceManager, 'checkpoint' | 'rollback'>;
  clock: Clock;
  ids: IdGenerator;
  runtime: TaskGraphRuntime;
}

export class TaskGraphRunner {
  constructor(private readonly dependencies: TaskGraphRunnerDependencies) {}

  run(input: TaskGraphRunInput): Promise<StoredArtifact> {
    return withSpan(
      'foundry.step',
      {
        'foundry.step.node_id': input.node.id,
        'foundry.step.id': input.node.id,
        'foundry.step.type': 'for-each-task',
      },
      () => this.runTraced(input),
    );
  }

  private async runTraced(input: TaskGraphRunInput): Promise<StoredArtifact> {
    const { project, node } = input;
    const graphArtifact = await this.dependencies.artifacts.getLatest(
      project.id,
      node.taskGraphArtifact,
    );
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
    validateTaskAcceptanceChannels(tasks, node);
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
      latest = await this.executeTask(input, task, pinnedInputs);
      completed.add(task.id);
    }
    if (!latest) throw new ExecutionError(`Node ${node.id} walked an empty task graph`);
    return latest;
  }

  private async executeTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    pinnedInputs: readonly ArtifactReference[],
  ): Promise<StoredArtifact> {
    const { project, workflow, node, runId, signal } = input;
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
    const routing = resolveRoutingEntry(workflow.routing, workflow.id, step.taskKind);
    const browserAcceptance = taskUsesBrowserAcceptance(task, node);
    const qualityAttemptStride =
      (browserAcceptance ? 2 : 1) * ((node.repair?.maxAttempts ?? 0) + 1);
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
      (await this.dependencies.workspaces.checkpoint(project.id, `${node.id}-${task.id}-${runId}`));
    let attemptCheckpoint = taskCheckpoint;
    const startAttempt =
      resumedFailure?.attempt ?? (await this.firstTaskAttempt(runId, node.id, step.id));
    let routingStartIndex = resumedFailure?.routingStartIndex ?? 0;
    if (resumedFailure?.checkpoint) {
      await this.dependencies.workspaces.rollback(project.id, resumedFailure.checkpoint);
    }
    let lastError: unknown;
    try {
      for (let attempt = startAttempt; attempt <= maxAttempts; attempt += 1) {
        await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
        const qualityAttemptBase = (attempt - 1) * qualityAttemptStride;
        let implementation: StoredArtifact | undefined;
        try {
          implementation = await this.dependencies.runtime.executeStep({
            project,
            workflow,
            step,
            runId,
            nodeId: node.id,
            signal,
            iteration: attempt,
            pinnedArtifacts: pinnedInputs,
            routingStartIndex,
          });
          assertAgentNotBlocked(implementation, {
            taskId: task.id,
            stepId: step.id,
            nodeId: node.id,
          });
          const repaired = await this.verifyTask(
            input,
            task,
            implementation,
            pinnedInputs,
            qualityAttemptBase,
          );
          attemptCheckpoint = await this.dependencies.workspaces.checkpoint(
            project.id,
            `${node.id}-${task.id}-${runId}-verified`,
          );
          const asserted = browserAcceptance
            ? await this.assertTask(input, task, pinnedInputs, qualityAttemptBase)
            : null;
          const reverified = asserted
            ? await this.verifyTask(
                input,
                task,
                asserted,
                pinnedInputs,
                qualityAttemptBase + (node.repair?.maxAttempts ?? 0) + 1,
              )
            : null;
          const commit = await this.commitForArtifact(
            runId,
            reverified ?? asserted ?? repaired ?? implementation,
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
              ...executorOutcome(implementation),
              artifact: implementation.metadata.name,
              revision: implementation.metadata.revision,
            },
          });
          return implementation;
        } catch (error) {
          if (!this.isTaskAttemptFailure(error, signal)) throw error;
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
                // Machine-readable discriminator for #528: a consumer
                // branches on this field instead of matching the message.
                ...(error instanceof BrowserInfrastructureError
                  ? { infrastructureFailure: error.diagnosis }
                  : {}),
                // Machine-readable discriminator for #537, mirroring
                // #528's `infrastructureFailure` above: a consumer branches
                // on this field instead of matching the message.
                ...(error instanceof AgentBlockedError ? { blockedReason: error.reason } : {}),
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
          await this.dependencies.workspaces.rollback(project.id, attemptCheckpoint);
        }
      }
      throw new ExecutionError(
        `Task ${task.id} failed after ${maxAttempts} attempt(s): ${errorMessage(lastError)}`,
      );
    } catch (error) {
      if (this.isTaskAttemptFailure(error, signal)) {
        await this.dependencies.workspaces.rollback(project.id, attemptCheckpoint);
      }
      throw error;
    }
  }

  private async resumedTaskFailure(
    projectId: string,
    runId: string,
    nodeId: string,
    taskId: string,
    stepId: string,
    routing: ReturnType<typeof resolveRoutingEntry>,
  ): Promise<{ attempt: number; routingStartIndex: number; checkpoint?: string } | undefined> {
    const terminal = (await this.dependencies.events.list(projectId))
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
    const failedAttempt = terminal.data.attempt;
    if (typeof failedAttempt !== 'number') return undefined;

    const stepRun = (await this.dependencies.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          candidate.iteration === failedAttempt &&
          !candidate.invalidatedAt,
      )
      .at(-1);
    if (!stepRun || stepRun.status !== 'completed') return undefined;

    const attempt = (await this.dependencies.stepAttempts.list(runId, stepRun.id)).at(-1);
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

  private async failedTaskExecutor(
    runId: string,
    nodeId: string,
    stepId: string,
    iteration: number,
  ): Promise<{ executor?: string; modelId?: string; attemptedExecutors?: string[] }> {
    const stepRun = (await this.dependencies.stepRuns.list(runId))
      .filter(
        (candidate) =>
          candidate.nodeId === nodeId &&
          candidate.stepId === stepId &&
          (candidate.iteration ?? 1) === iteration,
      )
      .at(-1);
    if (!stepRun) return {};
    const attempts = await this.dependencies.stepAttempts.list(runId, stepRun.id);
    const last = attempts.at(-1);
    if (!last) return {};
    return {
      executor: last.provider,
      ...(last.modelId ? { modelId: last.modelId } : {}),
      attemptedExecutors: attempts.map((attempt) => attempt.provider),
    };
  }

  private async firstTaskAttempt(runId: string, nodeId: string, stepId: string): Promise<number> {
    const previous = (await this.dependencies.stepRuns.list(runId)).filter(
      (candidate) =>
        candidate.nodeId === nodeId && candidate.stepId === stepId && !candidate.invalidatedAt,
    );
    const completed = previous.find((candidate) => candidate.status === 'completed');
    if (completed) return completed.iteration ?? 1;
    return Math.max(0, ...previous.map((candidate) => candidate.iteration ?? 0)) + 1;
  }

  private async commitForArtifact(
    runId: string,
    artifact: StoredArtifact,
  ): Promise<string | undefined> {
    const { stepRunId, attemptId } = artifact.metadata;
    if (!stepRunId || !attemptId) return undefined;
    return (await this.dependencies.stepAttempts.get(runId, stepRunId, attemptId))?.commit;
  }

  private async assertTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    pinnedInputs: readonly ArtifactReference[],
    iterationBase = 0,
  ): Promise<StoredArtifact | null> {
    const { project, workflow, node, runId, signal } = input;
    if (task.acceptanceMode === 'deterministic-only') return null;
    if (!node.browser || !node.repair) {
      if (task.acceptanceMode === 'browser-visible') {
        throw new ExecutionError(
          `Task ${task.id} declares browser-visible acceptance, but the workflow has no browser assertion channel`,
        );
      }
      return null;
    }
    const planStep = taskBrowserPlanStep(node.browser.plan, task);
    const checkStep = taskBrowserCheckStep(node.browser.check, task);
    const repairStep = taskBrowserRepairStep(node.repair, node.browser, task);

    await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
    const plan = await this.dependencies.runtime.executeStep({
      project,
      workflow,
      step: planStep,
      runId,
      nodeId: node.id,
      signal,
      iteration: 1,
      pinnedArtifacts: pinnedInputs,
    });
    const declared = AgentArtifactSchema.safeParse(plan.content);
    if (declared.success && declared.data.status === 'blocked') {
      if (task.acceptanceMode === 'browser-visible') {
        throw new ExecutionError(
          `Task ${task.id} declares browser-visible acceptance, but its browser plan refused the assertion`,
        );
      }
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
      throw new ExecutionError(
        `Task ${task.id}: ${planStep.id} produced neither a valid browser test plan nor a "blocked" answer`,
      );
    }

    const planReference = artifactReference(plan);
    let repaired: StoredArtifact | null = null;
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
      const report = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: checkStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
        pinnedArtifacts: [planReference],
      });
      const parsed = BrowserVerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      if (approved) {
        await this.dependencies.runtime.resetConsecutiveRepairs(runId);
        await this.emit(project.id, 'quality.approved', `${task.id}: ${parsed.data.summary}`, {
          nodeId: node.id,
          runId,
          dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:${iteration}:approved`,
          data: { taskId: task.id, stepId: checkStep.id, iteration, asserted: true },
        });
        return repaired;
      }
      if (parsed.success && parsed.data.infrastructureFailure) {
        // A transport failure, not a quality gate: the harness never reached
        // the app, so there is nothing for a repair agent to fix (#528).
        // `BrowserInfrastructureError` (not plain `ExecutionError`) so the
        // outer catch below can attach a machine-readable marker to
        // `task.failed` instead of leaving the diagnosis only in prose.
        throw new BrowserInfrastructureError(
          `Task ${task.id}: browser verification never reached the app: ${parsed.data.infrastructureFailure}`,
          parsed.data.infrastructureFailure,
        );
      }
      const failedStep = parsed.success
        ? parsed.data.steps.find((candidate) => candidate.status !== 'passed')
        : undefined;
      const summary = parsed.success
        ? parsed.data.summary
        : `${checkStep.id} did not produce a browser verification report`;
      if (round > node.repair.maxAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed its browser assertion after ${node.repair.maxAttempts} repair attempt(s): ${summary}`,
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
          maxRepairAttempts: node.repair.maxAttempts,
          ...(failedStep ? { failedStepId: failedStep.stepId } : {}),
        },
      });
      repaired = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: repairStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
        pinnedArtifacts: [...pinnedInputs, planReference, artifactReference(report)],
      });
      assertAgentNotBlocked(repaired, { taskId: task.id, stepId: repairStep.id, nodeId: node.id });
      await this.dependencies.runtime.recordCompletedRepair({
        runId,
        nodeId: node.id,
        stepId: repairStep.id,
        iteration,
        signal,
      });
    }
  }

  private isTaskAttemptFailure(error: unknown, signal: AbortSignal): boolean {
    return !this.dependencies.runtime.isControlFlowError(error, signal);
  }

  private async verifyTask(
    input: TaskGraphRunInput,
    task: PlanTask,
    implementation: StoredArtifact,
    pinnedInputs: readonly ArtifactReference[],
    iterationBase = 0,
  ): Promise<StoredArtifact | null> {
    const { project, workflow, node, runId, signal } = input;
    if (!node.verify || !node.repair) return null;
    const verifyStep = taskVerifyStep(node.verify, task);
    const repairStep = taskRepairStep(node.repair, task);
    const startedAt = this.dependencies.clock.now().getTime();
    let repaired: StoredArtifact | null = null;
    for (let round = 1; ; round += 1) {
      const iteration = iterationBase + round;
      await this.dependencies.runtime.assertExecutionMayContinue(runId, signal);
      const report = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: verifyStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
      });
      const parsed = VerificationReportSchema.safeParse(report.content);
      const approved = parsed.success && parsed.data.approved;
      await this.dependencies.runtime.recordDeterministicOutcome({
        projectId: project.id,
        workflowId: workflow.id,
        nodeId: node.id,
        runId,
        implementation,
        report,
        approved,
        iteration,
        durationMs: this.dependencies.clock.now().getTime() - startedAt,
      });
      if (approved) {
        await this.dependencies.runtime.resetConsecutiveRepairs(runId);
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
      if (round > node.repair.maxAttempts) {
        throw new QualityGateError(
          `Task ${task.id} failed verification after ${node.repair.maxAttempts} repair attempt(s): ${summary}`,
          node.id,
        );
      }
      await this.emit(project.id, 'quality.repair_requested', `${task.id}: ${summary}`, {
        nodeId: node.id,
        runId,
        dedupeKey: `${runId}:task:${node.id}:${task.id}:${iteration}:repair_requested`,
        data: {
          taskId: task.id,
          stepId: repairStep.id,
          iteration,
          maxRepairAttempts: node.repair.maxAttempts,
        },
      });
      repaired = await this.dependencies.runtime.executeStep({
        project,
        workflow,
        step: repairStep,
        runId,
        nodeId: node.id,
        signal,
        iteration,
        pinnedArtifacts: [...pinnedInputs, artifactReference(report)],
      });
      assertAgentNotBlocked(repaired, { taskId: task.id, stepId: repairStep.id, nodeId: node.id });
      await this.dependencies.runtime.recordCompletedRepair({
        runId,
        nodeId: node.id,
        stepId: repairStep.id,
        iteration,
        signal,
      });
    }
  }

  private async loadInputArtifacts(
    projectId: string,
    names: readonly string[],
    pinnedArtifacts: readonly ArtifactReference[],
  ): Promise<StoredArtifact[]> {
    const artifacts = await Promise.all(
      names.map(async (name) => {
        const pinned = pinnedArtifacts.find((artifact) => artifact.name === name);
        if (!pinned) return this.dependencies.artifacts.getLatest(projectId, name);
        const artifact = await this.dependencies.artifacts.getRevision(
          projectId,
          pinned.name,
          pinned.revision,
        );
        if (!artifact || artifact.metadata.sha256 !== pinned.sha256) {
          throw new NotFoundError(`Artifact ${pinned.name} revision ${pinned.revision} not found`);
        }
        return artifact;
      }),
    );
    const missing = names.filter((_name, index) => artifacts[index] === null);
    if (missing.length > 0) {
      throw new NotFoundError(`Missing input artifact(s): ${missing.join(', ')}`);
    }
    return artifacts.filter((artifact): artifact is StoredArtifact => artifact !== null);
  }

  private emit(
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
    return this.dependencies.events.append({
      id: this.dependencies.ids.next(),
      projectId,
      type,
      createdAt: this.dependencies.clock.now().toISOString(),
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.dedupeKey ? { dedupeKey: options.dedupeKey } : {}),
      message,
      data: options.data ?? {},
    });
  }
}

function artifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

/**
 * A mutating agent (implement, verify-repair, browser-repair) that answers
 * `blocked` never touched the workspace, so it is a failed attempt for the
 * task loop, not a completed one (#537) — unlike the browser *plan* step,
 * where `blocked` is a valid "nothing to assert" answer (see
 * `taskBrowserPlanStep`'s prompt) and must not go through this guard. A
 * parse failure here is not this guard's business; the existing contract
 * checks downstream handle that.
 */
function assertAgentNotBlocked(
  artifact: StoredArtifact,
  context: { taskId: string; stepId: string; nodeId: string },
): void {
  const parsed = AgentArtifactSchema.safeParse(artifact.content);
  if (!parsed.success || parsed.data.status !== 'blocked') return;
  throw new AgentBlockedError(
    `Task ${context.taskId}: ${context.stepId} reported blocked: ${parsed.data.summary}`,
    context.nodeId,
    parsed.data.summary,
  );
}

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
      ...(task.acceptanceMode
        ? [`Acceptance mode: ${task.acceptanceMode}`]
        : ['Acceptance mode: legacy graph (preserve existing workflow behavior).']),
      ...(task.dependsOn.length > 0 ? [`Depends on: ${task.dependsOn.join(', ')}`] : []),
      'Implement only this task. Earlier tasks are already implemented and committed in the workspace.',
    ].join('\n'),
  };
}

function taskVerifyStep(verify: VerifyStep, task: PlanTask): VerifyStep {
  return { ...verify, id: taskStepId(verify.id, task.id), title: `${task.id}: ${verify.title}` };
}

function taskRepairStep(repair: AgentStep, task: PlanTask): AgentStep {
  return {
    ...repair,
    id: taskStepId(repair.id, task.id),
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

function taskUsesBrowserAcceptance(task: PlanTask, node: ForEachTaskStep): boolean {
  return (
    task.acceptanceMode === 'browser-visible' ||
    (task.acceptanceMode === undefined && node.browser !== undefined)
  );
}

function validateTaskAcceptanceChannels(tasks: readonly PlanTask[], node: ForEachTaskStep): void {
  const browserTask = tasks.find((task) => task.acceptanceMode === 'browser-visible');
  if (browserTask && !node.browser) {
    throw new ExecutionError(
      `Task ${browserTask.id} declares browser-visible acceptance, but the workflow has no browser assertion channel`,
    );
  }
}

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

function taskBrowserCheckStep(check: VerifyStep, task: PlanTask): VerifyStep {
  return { ...check, id: taskStepId(check.id, task.id), title: `${task.id}: ${check.title}` };
}

function taskBrowserRepairStep(
  repair: AgentStep,
  browser: TaskBrowserAssertion,
  task: PlanTask,
): AgentStep {
  return {
    ...repair,
    id: taskStepId(browserRepairId(repair.id), task.id),
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

function executorOutcome(artifact: StoredArtifact): { executor?: string; modelId?: string } {
  const route = artifact.metadata.routeDecision;
  if (!route) return {};
  const executed = route.executed ?? route.selected;
  return { executor: executed.model.provider, modelId: executed.model.id };
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
