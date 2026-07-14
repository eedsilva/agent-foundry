import type {
  AgentArtifact,
  AgentExecutionResult,
  AgentStep,
  ExecutableStep,
  Project,
  ProjectEvent,
  QualityLoopStep,
  RankedModel,
  RunError,
  RouteDecision,
  StepAttempt,
  StepRun,
  StoredArtifact,
  VerifyStep,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { AGENT_ARTIFACT_JSON_SCHEMA } from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  ExecutorRegistry,
  HarnessRepository,
  HarnessSelection,
  IdGenerator,
  MetricsRepository,
  ModelRouter,
  ProjectRepository,
  StepAttemptRepository,
  StepRunRepository,
  VerificationService,
  WorkflowRunRepository,
  WorkflowRepository,
  WorkspaceManager,
} from '@agent-foundry/domain';
import {
  ExecutionError,
  NotFoundError,
  QualityGateError,
  RunCancelledError,
  errorMessage,
  getValueAtPath,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';

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
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly workflows: WorkflowRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly metrics: MetricsRepository,
    private readonly executors: ExecutorRegistry,
    private readonly verifier: VerificationService,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: OrchestratorOptions,
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
    if (run.status === 'cancelled') return;
    if (run.status === 'cancel_requested') {
      await this.finalizeCancellation(run.id, projectId);
      return;
    }
    run = await this.runs.update(
      transitionWorkflowRun(run, 'running', this.clock.now()),
      run.version,
    );
    await this.syncProjectSummary(run);
    await this.emit(projectId, 'project.started', `Workflow ${workflow.id} started.`, {
      runId: run.id,
    });

    const cancellation = new AbortController();
    const stopWatching = this.watchForCancellation(run.id, cancellation);
    try {
      await this.workspaces.ensureGit(projectId);
      for (const node of workflow.nodes) {
        throwIfCancelled(cancellation.signal, run.id);
        await this.emit(projectId, 'node.started', node.title, {
          nodeId: node.id,
          runId: run.id,
        });
        await this.executeNode(project, workflow, node, run.id, cancellation.signal);
        await this.emit(projectId, 'node.completed', node.title, {
          nodeId: node.id,
          runId: run.id,
        });
      }
      const latest = await this.requireRun(run.id);
      run = await this.runs.update(
        transitionWorkflowRun(latest, 'completed', this.clock.now()),
        latest.version,
      );
      await this.syncProjectSummary(run);
      await this.emit(projectId, 'project.completed', `Workflow ${workflow.id} completed.`, {
        runId: run.id,
      });
    } catch (error) {
      if (isCancellation(error, cancellation.signal)) {
        await this.finalizeCancellation(run.id, projectId);
        return;
      }
      const latest = await this.requireRun(run.id);
      if (latest.status === 'running') {
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

  private watchForCancellation(runId: string, controller: AbortController): () => void {
    let stopped = false;
    let timer: NodeJS.Timeout;
    const poll = async (): Promise<void> => {
      if (stopped || controller.signal.aborted) return;
      try {
        const run = await this.runs.get(runId);
        if (run && (run.status === 'cancel_requested' || run.status === 'cancelled')) {
          controller.abort();
          return;
        }
      } catch {
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
    let run = await this.requireRun(runId);
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

  private async executeNode(
    project: Project,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    if (node.type === 'quality-loop')
      return this.executeQualityLoop(project, workflow, node, runId, signal);
    return this.executeStep(project, workflow, node, runId, node.id, signal);
  }

  private async executeQualityLoop(
    project: Project,
    workflow: WorkflowDefinition,
    node: QualityLoopStep,
    runId: string,
    signal: AbortSignal,
  ): Promise<StoredArtifact> {
    let qualitySubject: StoredArtifact | null = null;
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
    }

    let latest: StoredArtifact | null = null;
    for (let iteration = 1; iteration <= node.maxIterations; iteration += 1) {
      latest = await this.executeStep(
        project,
        workflow,
        node.check,
        runId,
        node.id,
        signal,
        iteration,
      );
      const approved = await this.conditionApproved(project.id, node);
      if (qualitySubject) await this.recordQualityOutcome(qualitySubject, approved);
      if (approved) {
        await this.emit(project.id, 'quality.approved', `${node.title} approved.`, {
          runId,
          nodeId: node.id,
          data: { iteration },
        });
        return latest;
      }

      if (iteration >= node.maxIterations) break;
      await this.emit(project.id, 'quality.repair_requested', `${node.title} requires repair.`, {
        runId,
        nodeId: node.id,
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
      );
    }

    throw new QualityGateError(
      `${node.title} did not satisfy ${node.approval.artifact}.${node.approval.path} after ${node.maxIterations} iteration(s).`,
      node.id,
    );
  }

  private async conditionApproved(projectId: string, node: QualityLoopStep): Promise<boolean> {
    const artifact = await this.artifacts.getLatest(projectId, node.approval.artifact);
    if (!artifact) return false;
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
  ): Promise<StoredArtifact> {
    throwIfCancelled(signal, runId);
    const timestamp = this.clock.now().toISOString();
    let stepRun: StepRun = {
      id: this.ids.next(),
      runId,
      nodeId,
      stepId: step.id,
      stepType: step.type,
      ...(iteration ? { iteration } : {}),
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
          ? await this.executeAgentStep(project, workflow, step, runId, stepRun, signal, iteration)
          : await this.executeVerifyStep(
              project,
              workflow,
              step,
              runId,
              stepRun,
              signal,
              iteration,
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

  private async executeVerifyStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: VerifyStep,
    runId: string,
    stepRun: StepRun,
    signal: AbortSignal,
    iteration?: number,
  ): Promise<StoredArtifact> {
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
        },
        signal,
      );
      throwIfCancelled(signal, runId);
      const artifact = await this.artifacts.put({
        projectId: project.id,
        name: step.outputArtifact,
        content: report,
        createdBy: `verifier:${step.id}`,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
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
    } catch (error) {
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
    signal: AbortSignal,
    loopIteration?: number,
  ): Promise<StoredArtifact> {
    const inputArtifacts = await this.loadInputArtifacts(project.id, step.inputArtifacts);
    const harness = await this.harness.select({
      role: step.role,
      taskKind: step.taskKind,
      stack: workflow.stack,
      tags: step.harnessTags,
    });
    const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts });
    const route = await this.router.route(profile);
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
          ...(loopIteration ? { loopIteration } : {}),
        },
      },
    );

    const candidates = [route.selected, ...route.fallbacks].slice(0, step.maxAttempts);
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
          outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
        });
        const result = await this.executeCandidate(
          project,
          step,
          runId,
          stepRun.id,
          attempt.id,
          candidate,
          signal,
        );
        if (step.mutatesWorkspace) {
          await this.workspaces.commit(project.id, `agent(${step.role}): ${step.title}`);
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
        return artifact;
      } catch (error) {
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
        await this.metrics.record({
          modelId: candidate.model.id,
          taskKind: step.taskKind,
          role: step.role,
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

  private async executeCandidate(
    project: Project,
    step: AgentStep,
    runId: string,
    stepRunId: string,
    attemptId: string,
    candidate: RankedModel,
    signal: AbortSignal,
  ): Promise<AgentExecutionResult> {
    await this.emit(project.id, 'agent.started', `${step.id} started on ${candidate.model.id}.`, {
      nodeId: step.id,
      runId,
      data: { modelId: candidate.model.id, provider: candidate.model.provider, attemptId },
    });
    const executor = this.executors.get(candidate.model.provider);
    const result = await executor.execute(
      {
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
        cwd: this.workspaces.workspacePath(project.id),
        mutatesWorkspace: step.mutatesWorkspace,
        timeoutMs: this.options.agentTimeoutMs,
        outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
      },
      signal,
    );
    // A result that arrives after cancellation was requested must never be promoted.
    throwIfCancelled(signal, runId);
    await this.metrics.record({
      modelId: candidate.model.id,
      taskKind: step.taskKind,
      role: step.role,
      success: true,
      durationMs: result.durationMs,
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(result.usage?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: result.usage.estimatedCostUsd }
        : {}),
    });
    return result;
  }

  private async loadInputArtifacts(projectId: string, names: string[]): Promise<StoredArtifact[]> {
    const artifacts = await Promise.all(
      names.map((name) => this.artifacts.getLatest(projectId, name)),
    );
    const missing = names.filter((_name, index) => artifacts[index] === null);
    if (missing.length) throw new NotFoundError(`Missing input artifact(s): ${missing.join(', ')}`);
    return artifacts.filter((artifact): artifact is StoredArtifact => artifact !== null);
  }

  private async recordQualityOutcome(artifact: StoredArtifact, approved: boolean): Promise<void> {
    const route = artifact.metadata.routeDecision;
    if (!route) return;
    const executed = route.executed ?? route.selected;
    await this.metrics.recordQuality({
      modelId: executed.model.id,
      taskKind: route.profile.taskKind,
      role: route.profile.role,
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
      message,
      data: options.data ?? {},
    });
  }
}

function artifactReference(artifact: StoredArtifact) {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function throwIfCancelled(signal: AbortSignal, runId: string): void {
  if (signal.aborted) throw new RunCancelledError(runId);
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof RunCancelledError;
}

function runError(error: unknown): RunError {
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
  if (run.status === 'completed') return 'completed';
  if (run.status === 'failed') return 'failed';
  if (run.status === 'cancelled') return 'cancelled';
  return 'running';
}

function isDecisionLog(
  value: unknown,
): value is { schemaVersion: '1'; entries: DecisionLogEntry[] } {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries);
}
