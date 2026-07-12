import type {
  AgentArtifact,
  AgentExecutionResult,
  AgentStep,
  ExecutableStep,
  Project,
  ProjectEvent,
  QualityLoopStep,
  RankedModel,
  RouteDecision,
  StoredArtifact,
  VerifyStep,
  WorkflowDefinition,
  WorkflowNode,
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
  VerificationService,
  WorkflowRepository,
  WorkspaceManager,
} from '@agent-foundry/domain';
import {
  ExecutionError,
  NotFoundError,
  QualityGateError,
  errorMessage,
  getValueAtPath,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';

interface OrchestratorOptions {
  agentTimeoutMs: number;
}

interface DecisionLogEntry {
  recordedAt: string;
  stepId: string;
  runId: string;
  role: string;
  decision: AgentArtifact['decisions'][number];
}

export class WorkflowOrchestrator {
  constructor(
    private readonly projects: ProjectRepository,
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

  async runProject(projectId: string, workflowId?: string): Promise<void> {
    const existing = await this.projects.get(projectId);
    if (!existing) throw new NotFoundError(`Project ${projectId} not found`);
    const workflow = await this.workflows.get(workflowId ?? existing.workflowId);
    let project = await this.updateProject(existing, { status: 'running', error: undefined });
    await this.emit(projectId, 'project.started', `Workflow ${workflow.id} started.`);

    try {
      await this.workspaces.ensureGit(projectId);
      for (const node of workflow.nodes) {
        project = await this.updateProject(project, { currentNodeId: node.id });
        await this.emit(projectId, 'node.started', node.title, { nodeId: node.id });
        await this.executeNode(project, workflow, node);
        await this.emit(projectId, 'node.completed', node.title, { nodeId: node.id });
      }
      project = await this.updateProject(project, {
        status: 'completed',
        currentNodeId: undefined,
        error: undefined,
      });
      await this.emit(projectId, 'project.completed', `Workflow ${workflow.id} completed.`);
    } catch (error) {
      await this.updateProject(project, {
        status: 'failed',
        error: errorMessage(error),
      });
      await this.emit(projectId, 'project.failed', errorMessage(error), {
        ...(project.currentNodeId ? { nodeId: project.currentNodeId } : {}),
      });
      throw error;
    }
  }

  private async executeNode(
    project: Project,
    workflow: WorkflowDefinition,
    node: WorkflowNode,
  ): Promise<StoredArtifact> {
    if (node.type === 'quality-loop') return this.executeQualityLoop(project, workflow, node);
    return this.executeStep(project, workflow, node);
  }

  private async executeQualityLoop(
    project: Project,
    workflow: WorkflowDefinition,
    node: QualityLoopStep,
  ): Promise<StoredArtifact> {
    let qualitySubject: StoredArtifact | null = null;
    if (node.setup) {
      const setupArtifact = await this.executeStep(project, workflow, node.setup);
      if (node.setup.type === 'agent') qualitySubject = setupArtifact;
    }

    let latest: StoredArtifact | null = null;
    for (let iteration = 1; iteration <= node.maxIterations; iteration += 1) {
      latest = await this.executeStep(project, workflow, node.check);
      const approved = await this.conditionApproved(project.id, node);
      if (qualitySubject) await this.recordQualityOutcome(qualitySubject, approved);
      if (approved) {
        await this.emit(project.id, 'quality.approved', `${node.title} approved.`, {
          nodeId: node.id,
          data: { iteration },
        });
        return latest;
      }

      if (iteration >= node.maxIterations) break;
      await this.emit(project.id, 'quality.repair_requested', `${node.title} requires repair.`, {
        nodeId: node.id,
        data: { iteration },
      });
      qualitySubject = await this.executeAgentStep(project, workflow, node.repair, iteration);
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
  ): Promise<StoredArtifact> {
    return step.type === 'agent'
      ? this.executeAgentStep(project, workflow, step)
      : this.executeVerifyStep(project, step);
  }

  private async executeVerifyStep(project: Project, step: VerifyStep): Promise<StoredArtifact> {
    const report = await this.verifier.verify({
      workspacePath: this.workspaces.workspacePath(project.id),
      scripts: step.scripts,
      includeGitDiffCheck: step.includeGitDiffCheck,
    });
    const artifact = await this.artifacts.put({
      projectId: project.id,
      name: step.outputArtifact,
      content: report,
      createdBy: `verifier:${step.id}`,
    });
    await this.emit(project.id, 'verification.completed', report.summary, {
      nodeId: step.id,
      data: { approved: report.approved },
    });
    await this.emitArtifactCreated(project.id, artifact, step.id);
    return artifact;
  }

  private async executeAgentStep(
    project: Project,
    workflow: WorkflowDefinition,
    step: AgentStep,
    loopIteration?: number,
  ): Promise<StoredArtifact> {
    const runId = this.ids.next();
    const inputArtifacts = await this.loadInputArtifacts(project.id, step.inputArtifacts);
    const harness = await this.harness.select({
      role: step.role,
      taskKind: step.taskKind,
      stack: workflow.stack,
      tags: step.harnessTags,
    });
    const profile = buildTaskProfile({ step, harness, artifacts: inputArtifacts });
    const route = await this.router.route(profile);
    const requestMarkdown = compileRequestMarkdown({
      projectId: project.id,
      runId,
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
      requestMarkdown,
      outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
    });

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
      if (checkpoint && index > 0) await this.workspaces.rollback(project.id, checkpoint);

      const attemptStartedAt = Date.now();
      try {
        const result = await this.executeCandidate(project, step, runId, candidate);
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
          routeDecision: executionRoute,
        });
        await this.persistRunRecord(
          project.id,
          step,
          result,
          candidate.model.id,
          runId,
          requestMarkdown,
          harness,
          inputArtifacts,
        );
        await this.appendDecisions(project.id, step, result.output, runId);
        await this.emitArtifactCreated(project.id, artifact, step.id, runId);
        await this.emit(project.id, 'agent.completed', result.output.summary, {
          nodeId: step.id,
          runId,
          data: {
            modelId: candidate.model.id,
            provider: candidate.model.provider,
            durationMs: result.durationMs,
            status: result.output.status,
          },
        });
        return artifact;
      } catch (error) {
        lastError = error;
        await this.metrics.record({
          modelId: candidate.model.id,
          taskKind: step.taskKind,
          role: step.role,
          success: false,
          durationMs: Date.now() - attemptStartedAt,
        });
        await this.persistFailureRecord(
          project.id,
          step,
          runId,
          index + 1,
          candidate.model.id,
          candidate.model.provider,
          error,
          Date.now() - attemptStartedAt,
        );
        await this.emit(project.id, 'agent.failed', errorMessage(error), {
          nodeId: step.id,
          runId,
          data: {
            modelId: candidate.model.id,
            provider: candidate.model.provider,
            attempt: index + 1,
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
    candidate: RankedModel,
  ): Promise<AgentExecutionResult> {
    await this.emit(project.id, 'agent.started', `${step.id} started on ${candidate.model.id}.`, {
      nodeId: step.id,
      runId,
      data: { modelId: candidate.model.id, provider: candidate.model.provider },
    });
    const executor = this.executors.get(candidate.model.provider);
    const result = await executor.execute({
      runId,
      projectId: project.id,
      stepId: step.id,
      role: step.role,
      taskKind: step.taskKind,
      provider: candidate.model.provider,
      model: candidate.model.model,
      prompt: compileCliPrompt(runId),
      cwd: this.workspaces.workspacePath(project.id),
      mutatesWorkspace: step.mutatesWorkspace,
      timeoutMs: this.options.agentTimeoutMs,
      outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
    });
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
    });
    await this.emitArtifactCreated(projectId, artifact, step.id, runId);
  }

  private async persistRunRecord(
    projectId: string,
    step: AgentStep,
    result: AgentExecutionResult,
    modelId: string,
    runId: string,
    requestMarkdown: string,
    harness: HarnessSelection,
    inputArtifacts: StoredArtifact[],
  ): Promise<void> {
    await this.artifacts.put({
      projectId,
      name: `run-${runId}`,
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
    });
  }

  private async persistFailureRecord(
    projectId: string,
    step: AgentStep,
    runId: string,
    attempt: number,
    modelId: string,
    provider: string,
    error: unknown,
    durationMs: number,
  ): Promise<void> {
    const details = error instanceof ExecutionError ? error.details : {};
    await this.artifacts.put({
      projectId,
      name: `run-${runId}-failure-${attempt}`,
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
        stdout: details.stdout?.slice(0, 50_000) ?? '',
        stderr: details.stderr?.slice(0, 50_000) ?? '',
      },
      createdBy: 'orchestrator',
      runId,
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

  private async updateProject(
    project: Project,
    patch: {
      status?: Project['status'];
      currentNodeId?: string | undefined;
      error?: string | undefined;
    },
  ): Promise<Project> {
    const updated: Project = {
      ...project,
      ...(patch.status ? { status: patch.status } : {}),
      updatedAt: this.clock.now().toISOString(),
    };
    if ('currentNodeId' in patch) {
      if (patch.currentNodeId === undefined) delete updated.currentNodeId;
      else updated.currentNodeId = patch.currentNodeId;
    }
    if ('error' in patch) {
      if (patch.error === undefined) delete updated.error;
      else updated.error = patch.error;
    }
    await this.projects.update(updated);
    return updated;
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

function isDecisionLog(
  value: unknown,
): value is { schemaVersion: '1'; entries: DecisionLogEntry[] } {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as { entries?: unknown }).entries;
  return Array.isArray(entries);
}
