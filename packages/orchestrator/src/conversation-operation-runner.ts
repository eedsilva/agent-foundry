import type {
  AgentExecutionRequest,
  ArtifactReference,
  Message,
  Operation,
  RunError,
  StepAttempt,
  StepRun,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { AGENT_ARTIFACT_JSON_SCHEMA } from '@agent-foundry/contracts';
import {
  ExecutionError,
  NotFoundError,
  errorMessage,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';
import { CONVERSATION_WORKFLOW_ID, buildConversationStep } from './conversation-step-config.js';

export interface ConversationOperationRunnerOptions {
  agentTimeoutMs: number;
}

function toArtifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function toRunError(error: unknown): RunError {
  const details = error instanceof ExecutionError ? error.details : {};
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
  };
}

export class ConversationOperationRunner {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly metrics: MetricsRepository,
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly conversations: ConversationRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ConversationOperationRunnerOptions,
  ) {}

  async run(projectId: string, runId: string, operationId: string): Promise<void> {
    const initialRun = await this.requireRun(runId);
    const operation = await this.requireOperation(projectId, operationId);
    const kind: 'plan' | 'build' = operation.kind === 'build' ? 'build' : 'plan';
    const message = await this.requireMessage(projectId, operation.messageId);
    const planArtifact = await this.loadPlanArtifact(projectId, operation);
    const step = buildConversationStep({ operationId, kind, message, planArtifact });

    const runState = await this.runs.update(
      transitionWorkflowRun(initialRun, 'running', this.clock.now()),
      initialRun.version,
    );

    const stepTimestamp = this.clock.now().toISOString();
    let stepRun: StepRun = {
      id: this.ids.next(),
      runId,
      nodeId: step.id,
      stepId: step.id,
      stepType: 'agent',
      status: 'pending',
      version: 1,
      createdAt: stepTimestamp,
      updatedAt: stepTimestamp,
    };
    await this.stepRuns.create(stepRun);
    stepRun = await this.stepRuns.update(
      transitionStepRun(stepRun, 'running', this.clock.now()),
      stepRun.version,
    );

    let checkpoint: string | null = null;
    let attempt: StepAttempt | undefined;
    try {
      const harness = await this.harness.select({
        role: step.role,
        taskKind: step.taskKind,
        stack: 'conversation',
        tags: step.harnessTags,
      });
      const profile = buildTaskProfile({ step, harness, artifacts: [], policy: undefined });
      const route = await this.router.route(profile);
      checkpoint = step.mutatesWorkspace
        ? await this.workspaces.checkpoint(projectId, `${step.id}-${runId}`)
        : null;

      const attemptTimestamp = this.clock.now().toISOString();
      attempt = {
        id: this.ids.next(),
        runId,
        stepRunId: stepRun.id,
        sequence: 1,
        executorKind: 'agent',
        provider: route.selected.model.provider,
        model: route.selected.model.model || route.selected.model.id,
        modelId: route.selected.model.id,
        status: 'running',
        version: 1,
        createdAt: attemptTimestamp,
        updatedAt: attemptTimestamp,
        startedAt: attemptTimestamp,
        ...(checkpoint ? { checkpoint } : {}),
        routeDecision: route,
        context: {
          projectId,
          workflowId: CONVERSATION_WORKFLOW_ID[kind],
          nodeId: step.id,
          stepId: step.id,
        },
        inputArtifacts: [],
        outputArtifacts: [],
      };
      await this.stepAttempts.create(attempt);

      const requestMarkdown = compileRequestMarkdown({
        projectId,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        workflowId: CONVERSATION_WORKFLOW_ID[kind],
        stack: 'conversation',
        step,
        harness,
        artifacts: [],
        workspacePath: this.workspaces.workspacePath(projectId),
      });
      await this.workspaces.writeRunContext({
        projectId,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        requestMarkdown,
        outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
      });

      const request: AgentExecutionRequest = {
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        projectId,
        stepId: step.id,
        role: step.role,
        taskKind: step.taskKind,
        provider: route.selected.model.provider,
        model: route.selected.model.model,
        prompt: compileCliPrompt(runId, stepRun.id, attempt.id),
        cwd: this.workspaces.workspacePath(projectId),
        mutatesWorkspace: step.mutatesWorkspace,
        timeoutMs: this.options.agentTimeoutMs,
        outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
      };
      const result = await this.executors.get(route.selected.model.provider).execute(request);

      const commit = step.mutatesWorkspace
        ? await this.workspaces.commit(projectId, `conversation(${kind}): ${step.title}`)
        : null;
      const executionRoute = { ...route, executed: route.selected };
      const artifact = await this.artifacts.put({
        projectId,
        name: `operation-${operationId}`,
        content: result.output,
        createdBy: `${step.role}:${route.selected.model.provider}/${route.selected.model.model || 'default'}`,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        routeDecision: executionRoute,
      });

      await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: result.durationMs,
          ...(commit ? { commit } : {}),
          routeDecision: executionRoute,
          outputArtifacts: [toArtifactReference(artifact)],
        }),
        attempt.version,
      );
      await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      await this.runs.update(
        transitionWorkflowRun(runState, 'completed', this.clock.now()),
        runState.version,
      );
      await this.metrics.record({
        modelId: route.selected.model.id,
        taskKind: step.taskKind,
        role: step.role,
        success: true,
        durationMs: result.durationMs,
      });
      await this.events.append({
        id: this.ids.next(),
        projectId,
        type: 'operation.completed',
        message: `${step.title} completed.`,
        createdAt: this.clock.now().toISOString(),
        data: { operationId, runId, kind },
      });
    } catch (error) {
      if (checkpoint) await this.workspaces.rollback(projectId, checkpoint);
      const runErr = toRunError(error);
      if (attempt && attempt.status === 'running') {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'failed', this.clock.now(), { error: runErr }),
          attempt.version,
        );
      }
      await this.stepRuns.update(
        transitionStepRun(stepRun, 'failed', this.clock.now(), { error: runErr }),
        stepRun.version,
      );
      await this.runs.update(
        transitionWorkflowRun(runState, 'failed', this.clock.now(), { error: runErr }),
        runState.version,
      );
      await this.events.append({
        id: this.ids.next(),
        projectId,
        type: 'operation.failed',
        message: errorMessage(error),
        createdAt: this.clock.now().toISOString(),
        data: { operationId, runId, kind },
      });
    }
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  private async requireOperation(projectId: string, operationId: string): Promise<Operation> {
    const operation = await this.conversations.getOperation(projectId, operationId);
    if (!operation) throw new NotFoundError(`Operation ${operationId} not found`);
    return operation;
  }

  private async requireMessage(projectId: string, messageId: string): Promise<Message> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);
    return message;
  }

  private async loadPlanArtifact(
    projectId: string,
    operation: Operation,
  ): Promise<{ content: unknown } | undefined> {
    if (operation.kind !== 'build' || !operation.planOperationId) return undefined;
    const planOperation = await this.conversations.getOperation(
      projectId,
      operation.planOperationId,
    );
    const reference = planOperation?.artifactReferences[0];
    if (!reference) return undefined;
    const artifact = await this.artifacts.getRevision(
      projectId,
      reference.name,
      reference.revision,
    );
    return artifact ? { content: artifact.content } : undefined;
  }
}
