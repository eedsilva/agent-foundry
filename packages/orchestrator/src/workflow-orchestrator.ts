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
  RunPauseSnapshot,
  RunRetryDirective,
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
  RunPausedError,
  errorMessage,
  getValueAtPath,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { stepIdempotencyKey, workflowHash } from './idempotency.js';
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
    // Redelivery of an already-finished run (e.g. a crash between the final
    // state write and the queue ack) must be a no-op.
    if (run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') return;
    if (run.status === 'cancel_requested') {
      await this.finalizeCancellation(run.id, projectId);
      return;
    }
    if (run.status === 'pause_requested') {
      await this.finalizePause(run.id, projectId, workflow);
      return;
    }
    if (run.status !== 'running') {
      run = await this.runs.update(
        transitionWorkflowRun(run, 'running', this.clock.now()),
        run.version,
      );
    }
    await this.syncProjectSummary(run);
    await this.emit(projectId, 'project.started', `Workflow ${workflow.id} started.`, {
      runId: run.id,
      dedupeKey: `${run.id}:project.started`,
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
          dedupeKey: `${run.id}:node:${node.id}:started`,
        });
        await this.executeNode(project, workflow, node, run.id, cancellation.signal);
        await this.emit(projectId, 'node.completed', node.title, {
          nodeId: node.id,
          runId: run.id,
          dedupeKey: `${run.id}:node:${node.id}:completed`,
        });
      }
      const latest = await this.requireRun(run.id);
      run = await this.runs.update(
        transitionWorkflowRun(latest, 'completed', this.clock.now()),
        latest.version,
      );
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
      if (isCancellation(error, cancellation.signal)) {
        await this.finalizeCancellation(run.id, projectId);
        return;
      }
      const latest = await this.requireRun(run.id);
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
          dedupeKey: `${runId}:quality:${node.id}:${iteration}:approved`,
          data: { iteration },
        });
        return latest;
      }

      if (iteration >= node.maxIterations) break;
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
    const run = await this.requireRun(runId);
    // Pause only takes effect between steps: an in-flight step always
    // finishes (or fails) before the run parks.
    if (run.status === 'pause_requested') throw new RunPausedError(runId, nodeId);

    const inputArtifacts =
      step.type === 'agent' ? await this.loadInputArtifacts(project.id, step.inputArtifacts) : [];
    const idempotencyKey = stepIdempotencyKey({
      runId,
      nodeId,
      step,
      iteration,
      inputs: inputArtifacts.map(artifactReference),
    });
    const directive = run.retry;
    const isRetryTarget =
      directive !== undefined &&
      directive.nodeId === nodeId &&
      directive.stepId === step.id &&
      (directive.iteration ?? null) === (iteration ?? null);

    if (!isRetryTarget) {
      const reused = await this.reuseCompletedStep({
        project,
        step,
        runId,
        nodeId,
        iteration,
        idempotencyKey,
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
          ? await this.executeAgentStep(project, workflow, step, runId, stepRun, signal, {
              inputArtifacts,
              idempotencyKey,
              ...(isRetryTarget && directive.override ? { override: directive.override } : {}),
              ...(iteration ? { iteration } : {}),
            })
          : await this.executeVerifyStep(
              project,
              workflow,
              step,
              runId,
              stepRun,
              signal,
              idempotencyKey,
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
    preserve: boolean;
  }): Promise<StoredArtifact | null> {
    const { project, step, runId, nodeId, iteration, idempotencyKey, preserve } = input;
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
          ? await this.findArtifactByKey(project.id, step.outputArtifact, idempotencyKey)
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
    signal: AbortSignal,
    idempotencyKey: string,
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
    options: {
      inputArtifacts: StoredArtifact[];
      idempotencyKey: string;
      override?: RunRetryDirective['override'];
      iteration?: number;
    },
  ): Promise<StoredArtifact> {
    const { inputArtifacts, idempotencyKey, override, iteration: loopIteration } = options;
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

    // An explicit override skips fallbacks: the user chose the model.
    const candidates = override
      ? [await this.resolveOverrideCandidate(override, route)]
      : [route.selected, ...route.fallbacks].slice(0, step.maxAttempts);
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

  /**
   * Resolves an explicit retry override to a routable candidate. Prefers the
   * scored entry the router produced; falls back to the raw catalog entry
   * with a zeroed score so the audit trail stays schema-valid.
   */
  private async resolveOverrideCandidate(
    override: NonNullable<RunRetryDirective['override']>,
    route: RouteDecision,
  ): Promise<RankedModel> {
    const scored = [route.selected, ...route.fallbacks].find(
      (candidate) => candidate.model.id === override.modelId,
    );
    if (scored) return scored;
    const definition = (await this.router.catalog()).find((model) => model.id === override.modelId);
    if (!definition) {
      throw new ExecutionError(`Override model ${override.modelId} is not in the catalog`);
    }
    return {
      model: definition,
      score: {
        capability: 0,
        context: 0,
        speed: 0,
        cost: 0,
        reliability: 0,
        historical: 0,
        tagAffinity: 0,
        estimatedCostUsd: null,
        total: 0,
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
