import type {
  CreateProjectRequest,
  Project,
  ProjectDetailResponse,
  ProjectEvent,
  QueueJob,
  RetryPlanResponse,
  RetryStepRequest,
  RunDetailResponse,
  RunRetryDirective,
  StepRun,
  WorkflowRun,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  Clock,
  EventStore,
  HarnessRepository,
  IdGenerator,
  JobQueue,
  ModelRouter,
  ProjectRepository,
  ResumeDiagnostic,
  StepAttemptRepository,
  StepRunRepository,
  WorkspaceManager,
  WorkflowRunRepository,
  WorkflowRepository,
} from '@agent-foundry/domain';
import {
  NotFoundError,
  ResumeBlockedError,
  ValidationError,
  VersionConflictError,
  transitionWorkflowRun,
} from '@agent-foundry/domain';
import { workflowHash } from './idempotency.js';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly queue: JobQueue,
    private readonly workflows: WorkflowRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: CreateProjectRequest): Promise<Project> {
    await this.workflows.get(input.workflowId);
    const now = this.clock.now().toISOString();
    const projectId = this.ids.next();
    const runId = this.ids.next();
    const project: Project = {
      id: projectId,
      name: input.name,
      workflowId: input.workflowId,
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

    const attempts = await this.stepAttempts.list(runId, stepRunId);
    const checkpoint = attempts.filter((attempt) => attempt.checkpoint).at(-1)?.checkpoint;
    const now = this.clock.now().toISOString();

    await this.invalidateStepRun(target, 'retry-requested', now);
    const invalidated: string[] = [];
    if (input.mode === 'invalidate') {
      for (const step of downstream) {
        await this.invalidateStepRun(step, `invalidated-by-retry-of-${target.stepId}`, now);
        invalidated.push(step.id);
      }
    }

    const directive: RunRetryDirective = {
      stepRunId,
      nodeId: target.nodeId,
      stepId: target.stepId,
      ...(target.iteration ? { iteration: target.iteration } : {}),
      mode: input.mode,
      ...(override ? { override } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      requestedAt: now,
    };
    const updated = await this.runs.update(
      transitionWorkflowRun(run, 'queued', this.clock.now(), { retry: directive }),
      run.version,
    );
    await this.requeueProject(run.projectId, runId);
    await this.appendEvent(
      run.projectId,
      'step.retry_requested',
      `Retry of ${target.stepId} requested (${input.mode} downstream).`,
      runId,
      {
        stepRunId,
        mode: input.mode,
        ...(override ? { override } : {}),
        invalidatedStepRunIds: invalidated,
      },
    );
    return updated;
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
    // ponytail: workflows execute sequentially, so node order (then
    // iteration, then creation) is dependency order; switch to graph edges
    // if parallel nodes ever land.
    const workflow = await this.workflows.get(run.workflowId);
    const nodeOrder = new Map(workflow.nodes.map((node, index) => [node.id, index]));
    const position = (step: StepRun): [number, number, string, string] => [
      nodeOrder.get(step.nodeId) ?? Number.MAX_SAFE_INTEGER,
      step.iteration ?? 0,
      step.createdAt,
      step.id,
    ];
    const targetPosition = position(target);
    const all = await this.stepRuns.list(run.id);
    const downstream = all.filter((step) => {
      if (step.id === target.id || step.invalidatedAt) return false;
      const stepPosition = position(step);
      for (let index = 0; index < targetPosition.length; index += 1) {
        if (stepPosition[index]! > targetPosition[index]!) return true;
        if (stepPosition[index]! < targetPosition[index]!) return false;
      }
      return false;
    });
    return { target, downstream };
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

  private async requeueProject(projectId: string, runId: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const now = this.clock.now().toISOString();
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.error;
    await this.projects.update(updated, project.version);
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
  ): Promise<void> {
    await this.events.append({
      id: this.ids.next(),
      projectId,
      type,
      createdAt: this.clock.now().toISOString(),
      ...(runId ? { runId } : {}),
      message,
      data,
    });
  }
}
