import type {
  AgentExecutionRequest,
  Message,
  Operation,
  ProjectVersion,
  StepAttempt,
  StepRun,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  AGENT_ARTIFACT_JSON_SCHEMA,
  BrowserTestPlanArtifactSchema,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
} from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
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
  type StepEventRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
  type VerificationService,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';
import { CONVERSATION_WORKFLOW_ID, buildConversationStep } from './conversation-step-config.js';
import { compileContext } from './context-compiler.js';
import { artifactReference, persistStreamEvent, runError } from './workflow-orchestrator.js';
import { ProjectVersionService } from './project-version-service.js';
import type { BrowserVerificationCoordinator } from './browser-verification-coordinator.js';

export interface ConversationOperationRunnerOptions {
  agentTimeoutMs: number;
  verifier?: VerificationService;
  browserVerification?: Pick<BrowserVerificationCoordinator, 'verify'>;
}

export class ConversationOperationRunner {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly stepEvents: StepEventRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly metrics: MetricsRepository,
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly conversations: ConversationRepository,
    private readonly projectVersions: ProjectVersionService,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ConversationOperationRunnerOptions,
  ) {}

  async run(projectId: string, runId: string, operationId: string): Promise<void> {
    const initialRun = await this.requireRun(runId);
    const operation = await this.requireOperation(projectId, operationId);
    if (initialRun.projectId !== projectId) {
      throw new ValidationError(`Workflow run ${runId} does not belong to project ${projectId}`);
    }
    if (operation.runId !== runId) {
      throw new ValidationError(`Operation ${operationId} is not bound to workflow run ${runId}`);
    }
    const kind: 'plan' | 'build' | 'visual-edit' =
      operation.kind === 'build' || operation.kind === 'visual-edit' ? operation.kind : 'plan';
    const message = await this.requireMessage(projectId, operation.messageId);
    const planArtifact = await this.loadPlanArtifact(projectId, operation);
    const changeRequest = operation.changeRequestId
      ? ((await this.conversations.getChangeRequest(projectId, operation.changeRequestId)) ??
        undefined)
      : undefined;
    const allChangeRequests = await this.conversations.listChangeRequests(projectId);
    const versions = await this.projectVersions.list(projectId, 5);
    const compiledContext = compileContext({
      message,
      changeRequest,
      allChangeRequests,
      versions,
    });
    const step = buildConversationStep({
      operationId,
      kind,
      message,
      visualEdit: operation.visualEdit,
      planArtifact,
      contextDigest: compiledContext.digest,
    });

    let runState = await this.runs.update(
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
    let recordedVersion: ProjectVersion | null = null;
    let operationPromoted = false;
    let succeeded = false;
    try {
      if (operation.visualEdit && !(await this.workspaces.isClean(projectId))) {
        throw new ValidationError('Direct visual edits require a clean workspace baseline');
      }
      const harness = await this.harness.select({
        role: step.role,
        taskKind: step.taskKind,
        stack: 'conversation',
        tags: step.harnessTags,
      });
      if (changeRequest) {
        await this.conversations.updateChangeRequest({
          ...changeRequest,
          contextSources: [
            ...compiledContext.sources,
            ...harness.files.map((file) => ({ type: 'harness-fragment' as const, id: file.path })),
          ],
        });
      }
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
      const result = await this.executors
        .get(route.selected.model.provider)
        .execute(request, undefined, (event) =>
          persistStreamEvent(
            this.stepEvents,
            this.ids,
            this.clock,
            runId,
            stepRun.id,
            attempt!.id,
            event,
          ),
        );

      const directEvidence = operation.visualEdit
        ? await this.verifyDirectVisualEdit(projectId, runId, operation, attempt)
        : [];
      const commit = step.mutatesWorkspace
        ? await this.workspaces.commit(projectId, `conversation(${kind}): ${step.title}`)
        : null;
      if (operation.visualEdit && !commit) {
        throw new ValidationError('Direct visual edit produced no source diff');
      }
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

      recordedVersion = commit
        ? await this.projectVersions.recordFromStep({
            projectId,
            runId,
            stepRunId: stepRun.id,
            attemptId: attempt.id,
            commit,
          })
        : null;
      await this.conversations.updateOperation({
        ...operation,
        artifactReferences: [artifactReference(artifact), ...directEvidence],
        ...(recordedVersion ? { projectVersionId: recordedVersion.id } : {}),
      });
      operationPromoted = true;
      attempt = await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: result.durationMs,
          ...(commit ? { commit } : {}),
          routeDecision: executionRoute,
          outputArtifacts: [artifactReference(artifact), ...directEvidence],
        }),
        attempt.version,
      );
      stepRun = await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      runState = await this.runs.update(
        transitionWorkflowRun(runState, 'completed', this.clock.now()),
        runState.version,
      );
      succeeded = true;
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
      if (succeeded) {
        // The operation already durably completed (attempt/stepRun/runState all
        // reached their terminal success state); this failure is a secondary,
        // best-effort concern (metrics or event append). Do not roll back the
        // already-committed workspace and do not re-attempt repository writes
        // against records that have moved past these local versions.
        return;
      }
      let operationRestored = !operationPromoted;
      if (operationPromoted) {
        try {
          await this.conversations.updateOperation(operation);
          operationRestored = true;
        } catch {
          // Keep the version while the operation still references it; deleting it would create a dangling reference.
        }
      }
      if (recordedVersion && operationRestored) {
        try {
          await this.projectVersions.discardUnpromoted(recordedVersion);
        } catch {
          // Exact-match protection preserves a version that was promoted or changed concurrently.
        }
      }
      if (checkpoint) {
        try {
          await this.workspaces.rollback(projectId, checkpoint);
        } catch {
          // best-effort; the failed-state transitions below are the durable record
        }
      }
      const runErr = runError(error);
      if (attempt && attempt.status === 'running') {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'failed', this.clock.now(), { error: runErr }),
          attempt.version,
        );
      }
      if (stepRun.status === 'running') {
        stepRun = await this.stepRuns.update(
          transitionStepRun(stepRun, 'failed', this.clock.now(), { error: runErr }),
          stepRun.version,
        );
      }
      if (runState.status === 'running') {
        runState = await this.runs.update(
          transitionWorkflowRun(runState, 'failed', this.clock.now(), { error: runErr }),
          runState.version,
        );
      }
      if (operation.artifactReferences.length > 0) {
        // A build started from an approved plan inherits the plan's own
        // artifactReferences at creation time (OperationService.start), before
        // this run ever executes. If the run then fails, that inherited
        // reference must not linger — otherwise the chat UI would show diff/
        // artifact links for a failed operation as if it had produced them.
        try {
          await this.conversations.updateOperation({ ...operation, artifactReferences: [] });
        } catch {
          // best-effort; the failed-state transitions above are the durable record
        }
      }
      try {
        await this.events.append({
          id: this.ids.next(),
          projectId,
          type: 'operation.failed',
          message: errorMessage(error),
          createdAt: this.clock.now().toISOString(),
          data: { operationId, runId, kind },
        });
      } catch {
        // best-effort event; durable state (WorkflowRun/StepRun) is already recorded above
      }
    }
  }

  private async verifyDirectVisualEdit(
    projectId: string,
    runId: string,
    operation: Operation,
    attempt: StepAttempt,
  ): Promise<Operation['artifactReferences']> {
    const visualEdit = operation.visualEdit;
    if (!visualEdit) return [];
    if (await this.workspaces.isClean(projectId)) {
      throw new ValidationError('Direct visual edit produced no source diff');
    }
    if (!this.options.verifier || !this.options.browserVerification) {
      throw new ValidationError('Direct visual-edit verification is not configured');
    }

    const verification = await this.options.verifier.verify({
      workspacePath: this.workspaces.workspacePath(projectId),
      scripts: ['typecheck', 'lint', 'test', 'build'],
      includeGitDiffCheck: true,
    });
    const verificationArtifact = await this.artifacts.put({
      projectId,
      name: `visual-edit-verification-${operation.id}`,
      content: verification,
      createdBy: 'workspace-verifier:visual-edit',
      runId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.id,
    });
    if (!verification.approved) throw new ValidationError(verification.summary);

    const planArtifact = await this.artifacts.put({
      projectId,
      name: `visual-edit-browser-plan-${operation.id}`,
      content: directVisualEditBrowserPlan(operation, visualEdit),
      createdBy: 'conversation-runner:visual-edit',
      runId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.id,
    });
    const browserReport = await this.options.browserVerification.verify(
      {
        projectId,
        workspacePath: this.workspaces.workspacePath(projectId),
        runId,
        plan: planArtifact,
        allowedOrigins: [],
        evidencePolicy: DEFAULT_BROWSER_EVIDENCE_POLICY,
      },
      new AbortController().signal,
    );
    const browserArtifact = await this.artifacts.put({
      projectId,
      name: `visual-edit-browser-report-${operation.id}`,
      content: browserReport,
      createdBy: 'browser-verifier:visual-edit',
      runId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.id,
    });
    if (!browserReport.approved) throw new ValidationError(browserReport.summary);
    if (
      visualEdit.property !== 'text' &&
      browserReport.previewSession.evidence.screenshots.length === 0
    ) {
      throw new ValidationError('Style visual edits require screenshot evidence');
    }
    const evidence = browserReport.previewSession.evidence;
    return [
      ...[verificationArtifact, planArtifact, browserArtifact].map(artifactReference),
      ...evidence.screenshots.map(({ name, revision, sha256, sizeBytes }) => ({
        name,
        revision,
        sha256,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      })),
      ...[evidence.trace, evidence.video].filter(
        (reference): reference is NonNullable<typeof reference> => reference !== undefined,
      ),
    ];
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

function directVisualEditBrowserPlan(
  operation: Operation,
  edit: NonNullable<Operation['visualEdit']>,
) {
  return BrowserTestPlanArtifactSchema.parse({
    schemaVersion: '1',
    status: 'completed',
    summary: `Bounded browser smoke for ${edit.target.file}`,
    data: {
      schemaVersion: '1',
      id: `visual-edit-${operation.id}`,
      title: 'Verify visual edit',
      viewport: { width: 1280, height: 800 },
      steps: [
        {
          id: 'verify-visual-edit',
          title: 'Verify visual edit',
          action: { kind: 'goto', path: '/' },
          assertions:
            edit.property === 'text'
              ? [
                  {
                    kind: 'containsText',
                    locator: { by: 'text', text: edit.newValue, exact: true },
                    expected: edit.newValue,
                  },
                ]
              : [],
        },
      ],
    },
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  });
}
