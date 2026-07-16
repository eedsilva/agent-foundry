import type {
  ApprovalAction,
  ApprovalDecision,
  ApprovalRequest,
  ActorRef,
  ArtifactReference,
  CreateProjectRequest,
  Project,
  ProjectDetailResponse,
  ProjectEvent,
  QueueJob,
  RetryPlanResponse,
  RetryStepRequest,
  RunDetailResponse,
  RunAuditExport,
  RunRetryDirective,
  StepRun,
  WorkflowDefinition,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { FeedbackArtifactSchema } from '@agent-foundry/contracts';
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  Clock,
  EventStore,
  HarnessRepository,
  IdGenerator,
  JobQueue,
  ModelRouter,
  PolicyRepository,
  ProjectRepository,
  ResumeDiagnostic,
  StepAttemptRepository,
  StepRunRepository,
  WorkspaceManager,
  WorkflowRunRepository,
  WorkflowRepository,
} from '@agent-foundry/domain';
import {
  ApprovalConflictError,
  NotFoundError,
  ResumeBlockedError,
  ValidationError,
  VersionConflictError,
  normalizeApprovalDecision,
  transitionWorkflowRun,
  redactUnknown,
} from '@agent-foundry/domain';
import { policyHash, workflowHash } from './idempotency.js';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly approvalRequests: ApprovalRequestRepository,
    private readonly approvalDecisions: ApprovalDecisionRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly queue: JobQueue,
    private readonly workflows: WorkflowRepository,
    private readonly policies: PolicyRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateProjectRequest): Promise<Project> {
    await this.workflows.get(input.workflowId);
    const policyId = input.policyId ?? 'default';
    await this.policies.get(policyId);
    const now = this.clock.now().toISOString();
    const projectId = this.ids.next();
    const runId = this.ids.next();
    const project: Project = {
      id: projectId,
      name: input.name,
      workflowId: input.workflowId,
      policyId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
      currentRunId: runId,
    };
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: input.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.workspaces.ensure(project.id);
    await this.workspaces.writePrd(project.id, input.prd);
    await this.projects.create(project);
    await this.runs.create(run);
    await this.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: input.prd,
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    await this.appendEvent(project.id, 'project.created', 'Project and workspace created.');

    const job: QueueJob = {
      id: this.ids.next(),
      type: 'run-project',
      projectId: project.id,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    };
    await this.queue.enqueue(job);
    await this.appendEvent(project.id, 'project.queued', 'Project queued for orchestration.');
    return project;
  }

  async get(projectId: string): Promise<ProjectDetailResponse> {
    const project = await this.requireProject(projectId);
    const [artifacts, events] = await Promise.all([
      this.artifacts.listLatest(projectId),
      this.events.list(projectId),
    ]);
    return { project, artifacts, events };
  }

  async list(limit = 50): Promise<Project[]> {
    return this.projects.list(limit);
  }

  async getArtifact(projectId: string, name: string, revision?: number) {
    await this.requireProject(projectId);
    const artifact = revision
      ? await this.artifacts.getRevision(projectId, name, revision)
      : await this.artifacts.getLatest(projectId, name);
    if (!artifact) throw new NotFoundError(`Artifact ${name} not found in project ${projectId}`);
    return artifact;
  }

  async retry(projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running') return project;
    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;
    const saved = await this.projects.update(updated, project.version);
    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });
    await this.appendEvent(projectId, 'project.queued', 'Project manually re-queued.');
    return saved;
  }

  async cancelRun(runId: string): Promise<WorkflowRun> {
    for (let retry = 0; ; retry += 1) {
      const run = await this.runs.get(runId);
      if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
      // Idempotent: repeating a cancel is a no-op and emits no duplicate event.
      if (run.status === 'cancel_requested' || run.status === 'cancelled') return run;
      try {
        const updated = await this.runs.update(
          transitionWorkflowRun(run, 'cancel_requested', this.clock.now()),
          run.version,
        );
        await this.appendEvent(
          run.projectId,
          'run.cancel_requested',
          'Cancellation requested.',
          runId,
        );
        return updated;
      } catch (error) {
        if (!(error instanceof VersionConflictError) || retry >= 2) throw error;
      }
    }
  }

  async pauseRun(runId: string): Promise<WorkflowRun> {
    for (let retry = 0; ; retry += 1) {
      const run = await this.requireRun(runId);
      // Idempotent: repeating a pause is a no-op and emits no duplicate event.
      if (run.status === 'pause_requested' || run.status === 'paused') return run;
      try {
        const updated = await this.runs.update(
          transitionWorkflowRun(run, 'pause_requested', this.clock.now()),
          run.version,
        );
        await this.appendEvent(
          run.projectId,
          'run.pause_requested',
          'Pause requested; the run parks at the next step boundary.',
          runId,
        );
        return updated;
      } catch (error) {
        if (!(error instanceof VersionConflictError) || retry >= 2) throw error;
      }
    }
  }

  /**
   * Re-queues a paused run after proving the world it paused in is still the
   * world it would resume into. Any drift in workflow, harness, workspace
   * HEAD, or artifact inputs blocks the resume with a per-field diagnostic;
   * restarting the project is the explicit escape hatch.
   */
  async resumeRun(runId: string): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    // Idempotent: a resume already in flight leaves the run queued/running.
    if (run.status === 'queued' || run.status === 'running') return run;
    if (run.status !== 'paused') {
      throw new ValidationError(`Run ${runId} is ${run.status}; only paused runs can resume.`);
    }

    const diagnostics = await this.resumeDiagnostics(run);
    if (diagnostics.length > 0) {
      await this.appendEvent(
        run.projectId,
        'run.resume_blocked',
        `Resume blocked: ${diagnostics.map((item) => item.field).join(', ')} changed.`,
        runId,
        { diagnostics },
      );
      throw new ResumeBlockedError(runId, diagnostics);
    }

    const resumeNodeId = run.pause?.resumeNodeId;
    const updated = await this.runs.update(
      transitionWorkflowRun(run, 'queued', this.clock.now()),
      run.version,
    );
    await this.requeueProject(run.projectId, runId);
    await this.appendEvent(
      run.projectId,
      'run.resume_requested',
      resumeNodeId ? `Resume requested from ${resumeNodeId}.` : 'Resume requested.',
      runId,
      resumeNodeId ? { resumeNodeId } : {},
    );
    return updated;
  }

  async getRunDetail(runId: string): Promise<RunDetailResponse> {
    const run = await this.requireRun(runId);
    const steps = await this.stepRuns.list(runId);
    return {
      run,
      steps: await Promise.all(
        steps.map(async (step) => ({
          step,
          attempts: await this.stepAttempts.list(runId, step.id),
        })),
      ),
    };
  }

  /** What a retry of this step would touch, so the UI can show it up front. */
  async retryPlan(runId: string, stepRunId: string): Promise<RetryPlanResponse> {
    const run = await this.requireRun(runId);
    const { target, downstream } = await this.retryTargets(run, stepRunId);
    const artifacts = new Set<string>();
    for (const step of downstream) {
      for (const attempt of await this.stepAttempts.list(runId, step.id)) {
        for (const output of attempt.outputArtifacts) artifacts.add(output.name);
      }
    }
    return { target, downstream, artifacts: [...artifacts].sort() };
  }

  /**
   * Retries one step of a finished run. The original step run (and, when
   * requested, everything downstream of it) is marked invalidated — never
   * rewritten — and the run is re-queued with a directive the orchestrator
   * consumes: re-execute the target from its recorded checkpoint, optionally
   * on an explicitly chosen model, and reuse or re-run the rest.
   */
  async retryStep(runId: string, stepRunId: string, input: RetryStepRequest): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    if (run.status !== 'completed' && run.status !== 'failed') {
      throw new ValidationError(
        `Run ${runId} is ${run.status}; only completed or failed runs support step retry.`,
      );
    }
    const { target, downstream } = await this.retryTargets(run, stepRunId);

    let override: RunRetryDirective['override'];
    if (input.override) {
      const catalog = await this.router.catalog();
      const match = catalog.find(
        (model) =>
          model.provider === input.override?.provider &&
          (model.model === input.override.model || model.id === input.override.model),
      );
      if (!match) {
        throw new ValidationError(
          `No catalog model matches ${input.override.provider}/${input.override.model}.`,
        );
      }
      override = { modelId: match.id, provider: match.provider, model: match.model };
    }

    const { run: updated, invalidatedStepRunIds } = await this.invalidateFromStep(
      run,
      target,
      downstream,
      {
        mode: input.mode,
        override,
        reason: 'retry-requested',
      },
    );
    await this.appendEvent(
      run.projectId,
      'step.retry_requested',
      `Retry of ${target.stepId} requested (${input.mode} downstream).`,
      runId,
      {
        stepRunId,
        mode: input.mode,
        ...(override ? { override } : {}),
        invalidatedStepRunIds,
      },
    );
    return updated;
  }

  /** Requests pending decision for a run, each paired with its decision if one has arrived. */
  async listApprovals(
    runId: string,
  ): Promise<Array<{ request: ApprovalRequest; decision: ApprovalDecision | null }>> {
    await this.requireRun(runId);
    const requests = await this.approvalRequests.list(runId);
    return Promise.all(
      requests.map(async (request) => ({
        request,
        decision: normalizeApprovalDecision(await this.approvalDecisions.get(runId, request.id)),
      })),
    );
  }

  async exportRunAudit(runId: string): Promise<RunAuditExport> {
    const run = await this.requireRun(runId);
    const requests = await this.approvalRequests.list(runId);
    const entries: RunAuditExport['entries'] = requests.map((request) => ({
      kind: 'approval-request',
      id: request.id,
      timestamp: request.createdAt,
      request,
    }));
    for (const request of requests) {
      const decision = normalizeApprovalDecision(
        await this.approvalDecisions.get(runId, request.id),
      );
      if (decision) {
        entries.push({
          kind: 'approval-decision',
          id: decision.id,
          timestamp: decision.decidedAt,
          decision,
        });
      }
    }
    for (const metadata of await this.artifacts.listMetadata(run.projectId)) {
      if (metadata.kind !== 'feedback' || metadata.runId !== runId) continue;
      const artifact = await this.artifacts.getRevision(
        run.projectId,
        metadata.name,
        metadata.revision,
      );
      if (artifact) {
        entries.push({
          kind: 'feedback',
          id: `${metadata.name}-${metadata.revision}`,
          timestamp: metadata.createdAt,
          artifact,
        });
      }
    }
    entries.sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
    );
    return { schemaVersion: '1', runId, entries };
  }

  /**
   * Records a human decision and, in every case, requeues the run — the
   * orchestrator's next replay interprets what the decision means for
   * execution (advance, terminate as rejected, or redo the invalidated
   * range up to a fresh approval request). Idempotent: repeating an
   * already-decided request returns the recorded decision without acting
   * again.
   */
  async decideApproval(
    runId: string,
    requestId: string,
    input: {
      action: ApprovalAction;
      actor?: ActorRef | undefined;
      decidedBy?: string | undefined;
      note?: string | undefined;
    },
  ): Promise<{ run: WorkflowRun; decision: ApprovalDecision }> {
    if (Boolean(input.actor) === Boolean(input.decidedBy)) {
      throw new ValidationError('exactly one identity form is required: actor or decidedBy');
    }
    const run = await this.requireRun(runId);
    const request = await this.approvalRequests.get(runId, requestId);
    if (!request)
      throw new NotFoundError(`Approval request ${requestId} not found in run ${runId}`);

    let decision = normalizeApprovalDecision(await this.approvalDecisions.get(runId, requestId));
    if (decision) {
      // A decision already exists. A different requested action is a real
      // conflict (two reviewers disagreed) regardless of what the run has
      // done since — surface it rather than silently keeping whichever
      // decision happened to land first.
      if (decision.action !== input.action) {
        throw new ApprovalConflictError(runId, requestId, decision);
      }
      if (run.currentStepRunId !== request.stepRunId) return { run, decision };
      // Same action: if the run already moved past awaiting approval, this
      // is a true repeat — return it, no further action. If the run is
      // still parked, a prior call recorded the decision but crashed before
      // requeuing; fall through and finish that instead of silently
      // no-op'ing on the retry.
      if (run.status !== 'awaiting_approval') {
        // The run update is durable before the project/job requeue. If a
        // process dies in that window, the same settled decision repairs the
        // project summary and queue entry exactly once.
        if (run.status === 'queued') {
          await this.requeueProject(run.projectId, runId, this.approvalJobId(runId, decision.id));
          await this.appendApprovalDecisionEvent(run, requestId, decision);
        }
        return { run, decision };
      }
    } else {
      if (!request.allowedActions.includes(input.action)) {
        throw new ValidationError(
          `Action ${input.action} is not allowed for approval request ${requestId}.`,
        );
      }
      if (run.status !== 'awaiting_approval') {
        throw new ValidationError(`Run ${runId} is ${run.status}; no pending approval to decide.`);
      }
      const actor: ActorRef = input.actor ?? { kind: 'user', id: input.decidedBy! };
      const candidate = normalizeApprovalDecision({
        id: this.ids.next(),
        requestId,
        runId,
        stepRunId: request.stepRunId,
        action: input.action,
        decidedBy: input.actor ? (input.actor.displayName ?? input.actor.id) : input.decidedBy!,
        actor,
        ...(input.note ? { note: redactUnknown(input.note) as string } : {}),
        decidedAt: this.clock.now().toISOString(),
      })!;
      try {
        await this.approvalDecisions.create(candidate);
        decision = candidate;
      } catch (cause) {
        // Lost a simultaneous-write race: another decision was recorded
        // between our read and our write. Resolve against what actually won.
        const settled = normalizeApprovalDecision(
          await this.approvalDecisions.get(runId, requestId),
        );
        if (!settled) throw cause;
        if (settled.action !== input.action) {
          throw new ApprovalConflictError(runId, requestId, settled);
        }
        decision = settled;
      }
    }

    const workflow = await this.workflows.get(run.workflowId);
    const node = workflow.nodes.find((candidate) => candidate.id === request.nodeId);
    if (!node || node.type !== 'approval-gate') {
      throw new NotFoundError(
        `Approval gate node ${request.nodeId} not found in workflow ${run.workflowId}`,
      );
    }

    // Everything below acts on the settled `decision` record, not `input` —
    // on the crash-recovery path the retry's input may differ (e.g. a
    // different caller), and the originally recorded decision must win.
    const needsReturn =
      decision.action === 'request-changes' ||
      (decision.action === 'reject' && node.onReject === 'return-to-step');

    let updatedRun: WorkflowRun;
    if (needsReturn) {
      if (!node.returnToStepId) {
        throw new ValidationError(`Approval gate ${node.id} has no returnToStepId configured.`);
      }
      const allSteps = await this.stepRuns.list(runId);
      const invalidationReason = `approval-${decision.action}:${decision.id}`;
      const target =
        allSteps.find((step) => step.nodeId === node.returnToStepId && !step.invalidatedAt) ??
        allSteps.find(
          (step) =>
            step.nodeId === node.returnToStepId && step.invalidationReason === invalidationReason,
        );
      if (!target) {
        throw new NotFoundError(
          `Step for returnToStepId ${node.returnToStepId} not found in run ${runId}`,
        );
      }
      const downstream = this.downstreamOf(
        workflow,
        allSteps,
        target,
        Boolean(target.invalidatedAt),
      );

      let feedbackArtifact: ArtifactReference | undefined;
      if (decision.action === 'request-changes' && node.repairArtifact) {
        const existing = (
          await this.artifacts.listMetadata(run.projectId, node.repairArtifact)
        ).find((metadata) => metadata.sourceDecisionId === decision.id);
        const stored = existing
          ? await this.artifacts.getRevision(run.projectId, existing.name, existing.revision)
          : await this.artifacts.put({
              projectId: run.projectId,
              name: node.repairArtifact,
              content: FeedbackArtifactSchema.parse({
                schemaVersion: '1',
                actor: decision.actor ?? { kind: 'user', id: decision.decidedBy },
                sourceRequestId: request.id,
                sourceDecisionId: decision.id,
                runId,
                stepRunId: request.stepRunId,
                note: redactUnknown(decision.note ?? '') as string,
                createdAt: decision.decidedAt,
              }),
              createdBy: `approval-gate:${node.id}`,
              runId,
              stepRunId: request.stepRunId,
              kind: 'feedback',
              actor: decision.actor ?? { kind: 'user', id: decision.decidedBy },
              sourceDecisionId: decision.id,
            });
        if (!stored) throw new NotFoundError(`Feedback artifact ${node.repairArtifact} not found`);
        feedbackArtifact = {
          name: stored.metadata.name,
          revision: stored.metadata.revision,
          sha256: stored.metadata.sha256,
        };
      }

      ({ run: updatedRun } = await this.invalidateFromStep(run, target, downstream, {
        mode: 'invalidate',
        reason: invalidationReason,
        queueJobId: this.approvalJobId(runId, decision.id),
        ...(feedbackArtifact ? { feedbackArtifact } : {}),
      }));
    } else {
      updatedRun = await this.runs.update(
        // Clears any stale retry directive left by an earlier request-changes
        // cycle on this same run — otherwise a later replay could mistake an
        // already-superseded step for the current retry target.
        transitionWorkflowRun(run, 'queued', this.clock.now(), { retry: undefined }),
        run.version,
      );
      await this.requeueProject(run.projectId, runId, this.approvalJobId(runId, decision.id));
    }

    await this.appendApprovalDecisionEvent(run, requestId, decision);
    return { run: updatedRun, decision };
  }

  private async retryTargets(
    run: WorkflowRun,
    stepRunId: string,
  ): Promise<{ target: StepRun; downstream: StepRun[] }> {
    const target = await this.stepRuns.get(run.id, stepRunId);
    if (!target) throw new NotFoundError(`Step run ${stepRunId} not found in run ${run.id}`);
    if (target.invalidatedAt) {
      throw new ValidationError(
        `Step run ${stepRunId} was already invalidated; retry its successor.`,
      );
    }
    if (target.status === 'pending' || target.status === 'running') {
      throw new ValidationError(`Step run ${stepRunId} is still ${target.status}.`);
    }
    const workflow = await this.workflows.get(run.workflowId);
    const all = await this.stepRuns.list(run.id);
    return { target, downstream: this.downstreamOf(workflow, all, target) };
  }

  // ponytail: workflows execute sequentially, so node order (then iteration,
  // then creation) is dependency order; switch to graph edges if parallel
  // nodes ever land.
  private downstreamOf(
    workflow: WorkflowDefinition,
    allSteps: StepRun[],
    target: StepRun,
    includeInvalidated = false,
  ): StepRun[] {
    const nodeOrder = new Map(workflow.nodes.map((node, index) => [node.id, index]));
    const position = (step: StepRun): [number, number, string, string] => [
      nodeOrder.get(step.nodeId) ?? Number.MAX_SAFE_INTEGER,
      step.iteration ?? 0,
      step.createdAt,
      step.id,
    ];
    const targetPosition = position(target);
    return allSteps.filter((step) => {
      if (step.id === target.id || (!includeInvalidated && step.invalidatedAt)) return false;
      const stepPosition = position(step);
      for (let index = 0; index < targetPosition.length; index += 1) {
        if (stepPosition[index]! > targetPosition[index]!) return true;
        if (stepPosition[index]! < targetPosition[index]!) return false;
      }
      return false;
    });
  }

  /**
   * Shared by retryStep and decideApproval: invalidate a target step (and,
   * in 'invalidate' mode, everything downstream of it), then reopen the run
   * with a retry directive the orchestrator's replay consumes — same
   * checkpoint-rollback machinery either caller needs.
   */
  private async invalidateFromStep(
    run: WorkflowRun,
    target: StepRun,
    downstream: StepRun[],
    options: {
      mode: RunRetryDirective['mode'];
      override?: RunRetryDirective['override'];
      feedbackArtifact?: ArtifactReference;
      queueJobId?: string;
      reason: string;
    },
  ): Promise<{ run: WorkflowRun; invalidatedStepRunIds: string[] }> {
    const attempts = await this.stepAttempts.list(run.id, target.id);
    const checkpoint = attempts.filter((attempt) => attempt.checkpoint).at(-1)?.checkpoint;
    const now = this.clock.now().toISOString();

    if (!target.invalidatedAt) await this.invalidateStepRun(target, options.reason, now);
    const invalidatedStepRunIds: string[] = [];
    if (options.mode === 'invalidate') {
      for (const step of downstream) {
        if (step.invalidatedAt) continue;
        await this.invalidateStepRun(step, `invalidated-by-${options.reason}`, now);
        invalidatedStepRunIds.push(step.id);
      }
    }

    const directive: RunRetryDirective = {
      stepRunId: target.id,
      nodeId: target.nodeId,
      stepId: target.stepId,
      ...(target.iteration ? { iteration: target.iteration } : {}),
      mode: options.mode,
      ...(options.override ? { override: options.override } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(options.feedbackArtifact ? { feedbackArtifact: options.feedbackArtifact } : {}),
      requestedAt: now,
    };
    const updated = await this.runs.update(
      transitionWorkflowRun(run, 'queued', this.clock.now(), { retry: directive }),
      run.version,
    );
    await this.requeueProject(run.projectId, run.id, options.queueJobId);
    return { run: updated, invalidatedStepRunIds };
  }

  private async invalidateStepRun(step: StepRun, reason: string, now: string): Promise<void> {
    await this.stepRuns.update(
      { ...step, invalidatedAt: now, invalidationReason: reason, updatedAt: now },
      step.version,
    );
  }

  private async resumeDiagnostics(run: WorkflowRun): Promise<ResumeDiagnostic[]> {
    const snapshot = run.pause;
    if (!snapshot) {
      return [{ field: 'pauseSnapshot', expected: 'present', actual: 'missing' }];
    }
    const diagnostics: ResumeDiagnostic[] = [];
    const workflow = await this.workflows.get(run.workflowId);
    const currentWorkflowHash = workflowHash(workflow);
    if (currentWorkflowHash !== snapshot.workflowHash) {
      diagnostics.push({
        field: 'workflowVersion',
        expected: snapshot.workflowHash,
        actual: currentWorkflowHash,
      });
    }
    const harnessVersion = await this.harness.version();
    if (harnessVersion !== snapshot.harnessVersion) {
      diagnostics.push({
        field: 'harnessVersion',
        expected: snapshot.harnessVersion,
        actual: harnessVersion,
      });
    }
    if (run.policy) {
      const project = await this.requireProject(run.projectId);
      const policy = await this.policies.get(project.policyId);
      const actualPolicyHash = policyHash(policy);
      if (actualPolicyHash !== run.policy.hash) {
        diagnostics.push({
          field: 'policyVersion',
          expected: run.policy.hash,
          actual: actualPolicyHash,
        });
      }
    }
    const head = await this.workspaces.head(run.projectId);
    if ((head ?? 'none') !== (snapshot.workspaceHead ?? 'none')) {
      diagnostics.push({
        field: 'workspaceHead',
        expected: snapshot.workspaceHead ?? 'none',
        actual: head ?? 'none',
      });
    }
    const metadata = await this.artifacts.listMetadata(run.projectId);
    const latest = new Map<string, { revision: number; sha256: string }>();
    for (const item of metadata) {
      const current = latest.get(item.name);
      if (!current || current.revision < item.revision) {
        latest.set(item.name, { revision: item.revision, sha256: item.sha256 });
      }
    }
    const names = new Set([...Object.keys(snapshot.artifactHashes), ...latest.keys()]);
    for (const name of [...names].sort()) {
      const expected = snapshot.artifactHashes[name] ?? 'absent';
      const actual = latest.get(name)?.sha256 ?? 'absent';
      if (expected !== actual) {
        diagnostics.push({ field: `artifact:${name}`, expected, actual });
      }
    }
    return diagnostics;
  }

  private async requeueProject(projectId: string, runId: string, jobId?: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const now = this.clock.now().toISOString();
    if (project.status !== 'queued' || project.currentRunId !== runId) {
      const updated: Project = {
        ...project,
        status: 'queued',
        updatedAt: now,
        currentRunId: runId,
      };
      delete updated.error;
      await this.projects.update(updated, project.version);
    }
    await this.queue.enqueue({
      id: jobId ?? `run-project-${runId}`,
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });
  }

  private approvalJobId(runId: string, decisionId: string): string {
    return `run-project-${runId}-approval-${decisionId}`;
  }

  private async appendApprovalDecisionEvent(
    run: WorkflowRun,
    requestId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.appendEvent(
      run.projectId,
      'run.approval_decided',
      `${decision.action} recorded for approval ${requestId}.`,
      run.id,
      {
        requestId,
        action: decision.action,
        decidedBy: decision.decidedBy,
        ...(decision.actor ? { actor: decision.actor } : {}),
      },
      `approval-decision:${decision.id}`,
    );
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    return project;
  }

  private async appendEvent(
    projectId: string,
    type: ProjectEvent['type'],
    message: string,
    runId?: string,
    data: Record<string, unknown> = {},
    dedupeKey?: string,
  ): Promise<void> {
    await this.events.append({
      id: this.ids.next(),
      projectId,
      type,
      createdAt: this.clock.now().toISOString(),
      ...(runId ? { runId } : {}),
      message,
      data,
      ...(dedupeKey ? { dedupeKey } : {}),
    });
  }
}
