import type {
  ApprovalAction,
  ApprovalDecision,
  ApprovalRequest,
  ActorRef,
  ArtifactMetadata,
  ArtifactReference,
  CreateModelOverrideRequest,
  CreateProjectRequest,
  DiscardDraftRequest,
  DraftDetailResponse,
  ModelOverrideRecord,
  ModelDefinition,
  Project,
  ProjectDetailResponse,
  ProjectEvent,
  QualityObservation,
  QualityObservationInput,
  Provider,
  QueueJob,
  RetryPlanResponse,
  RetryProjectRequest,
  RetryStepRequest,
  RunDetailResponse,
  RunAuditExport,
  RunRetryDirective,
  StepRun,
  StoredArtifact,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowRun,
  ValidationCampaignPreview,
  ValidationPreflightReport,
} from '@agent-foundry/contracts';
import type {
  ApplicationEnvelopeQuestion,
  ApprovePrdRequest,
  ApprovePrdResponse,
  RevisePrdRequest,
  RevisePrdResponse,
} from '@agent-foundry/contracts';
import {
  createValidationCampaignExecution,
  FeedbackArtifactSchema,
  validateSupportedApplicationEnvelope,
} from '@agent-foundry/contracts';
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
  ModelOverrideRepository,
  PolicyRepository,
  ProjectRepository,
  ResumeDiagnostic,
  StepAttemptRepository,
  StepRunRepository,
  TransactionRunner,
  Tx,
  WorkspaceManager,
  WorkflowRunRepository,
  WorkflowRepository,
} from '@agent-foundry/domain';
import {
  ApplicationEnvelopeRejectedError,
  ApprovalConflictError,
  extractEnvelopeRequirements,
  latestArtifactsByName,
  NotFoundError,
  errorMessage,
  PrdApprovalConflictError,
  prdIdentity,
  ResumeBlockedError,
  StandardPrdRejectedError,
  ValidationError,
  VersionConflictError,
  browserRepairId,
  isTaskStepId,
  normalizeApprovalDecision,
  redactString,
  redactValidationPreflightReport,
  traceContextField,
  transitionWorkflowRun,
  validateStandardPrd,
} from '@agent-foundry/domain';
import { createTwoFilesPatch } from 'diff';
import { isMigrationApprovalGateId, policyHash, workflowHash } from './idempotency.js';
import { currentPrdApproval } from './prd-approval.js';
import type { QualityObservationService } from './quality-observation-service.js';

const RUN_PROJECT_MAX_ATTEMPTS = 2;
const INITIALIZATION_FAILURE_ATTEMPTS = 2;
const INITIALIZATION_INTERRUPTED =
  'Project initialization was interrupted before queue publication.';

function runProjectJob(project: Project, run: WorkflowRun, availableAt: string): QueueJob {
  return {
    id: `run-project-${run.id}`,
    type: 'run-project',
    projectId: project.id,
    workflowId: project.workflowId,
    runId: run.id,
    attempts: 0,
    maxAttempts: RUN_PROJECT_MAX_ATTEMPTS,
    createdAt: run.createdAt,
    availableAt,
    leaseEpoch: 0,
    ...traceContextField(),
  };
}

/** Deterministic unified diff between two PRD revisions (no timestamps). */
function revisionDiff(
  parentRevision: number,
  parentContent: string,
  revision: number,
  content: string,
): string {
  return createTwoFilesPatch(
    `prd@${parentRevision}`,
    `prd@${revision}`,
    parentContent,
    content,
    undefined,
    undefined,
    { context: 3 },
  );
}

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
    private readonly transactionRunner: TransactionRunner,
    private readonly workflows: WorkflowRepository,
    private readonly policies: PolicyRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly modelOverrides?: ModelOverrideRepository,
    private readonly qualityObservations?: QualityObservationService,
    private readonly validationCampaign?: ValidationCampaignPreview,
    private readonly validationPreflight?: () => Promise<ValidationPreflightReport | undefined>,
  ) {}

  async createModelOverride(
    runId: string,
    input: CreateModelOverrideRequest,
  ): Promise<ModelOverrideRecord> {
    const run = await this.requireRun(runId);
    if (!this.modelOverrides) throw new Error('Model override repository is not configured');
    const scope = input.scope;
    if (scope.kind === 'step') {
      const workflow = await this.workflows.get(run.workflowId);
      if (!isAgentStep(workflow, scope.nodeId, scope.stepId)) {
        throw new ValidationError(
          `Scope ${scope.nodeId}/${scope.stepId} does not identify an agent step in workflow ${workflow.id}.`,
        );
      }
    }
    const match = await this.resolveCatalogModel(input.modelId, input.provider, input.model);
    const audit = redactOverrideAudit(input);
    const override: Omit<ModelOverrideRecord, 'sequence'> = {
      id: this.ids.next(),
      runId,
      scope: input.scope,
      modelId: match.id,
      provider: match.provider,
      model: match.model,
      ...audit,
      createdAt: this.clock.now().toISOString(),
    };
    return this.modelOverrides.create(override);
  }

  async create(input: CreateProjectRequest): Promise<Project> {
    const validation = validateStandardPrd(input.prd);
    if (!validation.ok) {
      const maxLengthIssues = validation.issues.filter((issue) => issue.code === 'max-length');
      if (maxLengthIssues.length > 0) throw new StandardPrdRejectedError(maxLengthIssues);
    }
    const workflow = await this.workflows.get(input.workflowId);
    let canonicalPrd = input.prd;
    let questions: ApplicationEnvelopeQuestion[] = [];
    if (workflow.stack === 'nextjs') {
      if (!validation.ok) throw new StandardPrdRejectedError(validation.issues);
      canonicalPrd = validation.prd.canonicalMarkdown;
      const envelope = validateSupportedApplicationEnvelope(
        extractEnvelopeRequirements(canonicalPrd),
      );
      if (envelope.rejections.length > 0) {
        throw new ApplicationEnvelopeRejectedError(envelope.rejections);
      }
      questions = envelope.questions;
    }
    const policyId = input.policyId ?? 'default';
    await this.policies.get(policyId);
    const preflight = await this.validationPreflight?.();
    const runPreflight =
      preflight &&
      this.validationCampaign &&
      preflight.campaignId === this.validationCampaign.id &&
      preflight.sourceRevision === this.validationCampaign.sourceRevision
        ? preflight
        : undefined;
    if (this.validationCampaign && !runPreflight) {
      throw new ValidationError(
        'Validation preflight is missing or does not match the selected campaign.',
      );
    }
    if (runPreflight && runPreflight.status !== 'passed') {
      const failedBoundary = runPreflight.checks.find(
        (check) => check.status === 'failed',
      )?.boundary;
      throw new ValidationError(
        `Validation preflight ${runPreflight.status} at ${failedBoundary ?? 'unknown boundary'}.`,
      );
    }
    const now = this.clock.now().toISOString();
    const projectId = this.ids.next();
    const runId = this.ids.next();
    const projectDirectory = await this.workspaces.reserveProjectDirectory(
      projectId,
      input.projectDirectory,
    );
    // #602: nothing reaches the run queue before an explicit PRD approval, so
    // the project and its run are born awaiting that decision.
    const project: Project = {
      id: projectId,
      name: input.name,
      workflowId: input.workflowId,
      policyId,
      projectDirectory,
      status: 'awaiting_approval',
      version: 1,
      createdAt: now,
      updatedAt: now,
      currentRunId: runId,
    };
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: input.workflowId,
      status: 'awaiting_approval',
      version: 1,
      createdAt: now,
      updatedAt: now,
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

    const stagedProject: Project = {
      ...project,
      status: 'failed',
      error: INITIALIZATION_INTERRUPTED,
    };
    const stagedRun = transitionWorkflowRun(run, 'failed', this.clock.now(), {
      error: { name: 'ProjectInitializationError', message: INITIALIZATION_INTERRUPTED },
    });
    let createdProject = project;
    let scaffoldFiles: Array<{ path: string; content: string }> = [];
    try {
      scaffoldFiles = await this.harness.scaffoldFiles(workflow.stack);
      await this.transactionRunner.run(async (tx) => {
        await this.projects.create(stagedProject, tx);
        await this.runs.create(stagedRun, tx);
      });

      await this.workspaces.initializeProject(project.id, canonicalPrd, scaffoldFiles);
      await this.transactionRunner.run(async (tx) => {
        await this.appendEvent(project.id, 'project.created', 'Project and workspace created.', {
          runId,
          tx,
        });
        if (scaffoldFiles.length > 0) {
          await this.appendEvent(
            project.id,
            'scaffold.applied',
            `Applied ${scaffoldFiles.length} scaffold file(s) for stack '${workflow.stack}'.`,
            { runId, tx },
          );
        }
      });
    } catch (error) {
      const persistedProject = await this.projects.get(project.id);
      if (persistedProject) {
        try {
          if (!(await this.runs.get(runId))) {
            await this.runs.create({
              ...stagedRun,
              error: { name: 'ProjectInitializationError', message: errorMessage(error) },
            });
          }
          await this.markInitializationFailed(project.id, runId, errorMessage(error));
        } catch (stateError) {
          throw new AggregateError([error, stateError], errorMessage(error));
        }
      } else {
        const rollbackErrors: unknown[] = [];
        try {
          await this.workspaces.releaseProjectDirectory(project.id);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
        if (rollbackErrors.length === 0) {
          try {
            await this.workspaces.cleanup(project.id);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError([error, ...rollbackErrors], errorMessage(error));
        }
      }
      throw error;
    }

    // Artifacts are written after the transaction commits: `artifacts.project_id`
    // has a FK to `projects(id)`, and ArtifactStore.put isn't part of the
    // transactional seam (see the design note at the top of this task in the
    // plan) -- the project row must already be visible on its own connection.
    try {
      await this.artifacts.put({
        projectId: project.id,
        name: 'prd',
        content: canonicalPrd,
        contentType: 'text/markdown',
        createdBy: 'user',
        runId,
      });
      if (scaffoldFiles.length > 0) {
        await this.artifacts.put({
          projectId: project.id,
          name: 'scaffold-manifest',
          content: scaffoldFiles.map((file) => file.path),
          contentType: 'application/json',
          createdBy: `scaffold:${workflow.stack}`,
          runId,
        });
      }
      if (runPreflight) {
        await this.artifacts.put({
          projectId: project.id,
          name: 'validation-preflight',
          content: redactValidationPreflightReport(runPreflight),
          createdBy: `validation-preflight:${runPreflight.environmentId}`,
          runId,
        });
      }

      await this.appendEvent(
        project.id,
        'project.initialization_ready',
        'Project initialization completed; queue publication pending.',
        { runId, dedupeKey: `${runId}:project.initialization_ready` },
      );
      // #602: no queue publication here — approvePrd owns the only enqueue.
      await this.transactionRunner.run(async (tx) => {
        if (questions.length > 0) {
          await this.appendEvent(
            project.id,
            'prd.blocking_questions',
            'PRD has Blocking Questions; approval is blocked until a revision resolves them.',
            { runId, dedupeKey: `${runId}:prd.blocking_questions:1`, data: { questions }, tx },
          );
        }
        await this.runs.update(run, stagedRun.version, tx);
        createdProject = await this.projects.update(project, stagedProject.version, tx);
      });
    } catch (error) {
      const message = errorMessage(error);
      try {
        await this.markInitializationFailed(project.id, runId, message);
      } catch (stateError) {
        throw new AggregateError([error, stateError], message);
      }
      throw error;
    }

    return createdProject;
  }

  /**
   * Approves the current PRD Revision by its exact identity hash and performs
   * the only queue publication for a new run (#602). A stale hash conflicts;
   * envelope rejections and Blocking Questions block approval; replaying an
   * approval that already queued the run is a no-op.
   */
  async approvePrd(projectId: string, input: ApprovePrdRequest): Promise<ApprovePrdResponse> {
    const project = await this.requireProject(projectId);
    if (!project.currentRunId) {
      throw new ValidationError(`Project ${projectId} has no run awaiting PRD approval.`);
    }
    const run = await this.requireRun(project.currentRunId);
    const stored = await this.artifacts.getLatest(projectId, 'prd');
    if (!stored) throw new NotFoundError(`Artifact prd not found in project ${projectId}`);
    const canonicalPrd = String(stored.content);
    const identity = prdIdentity(canonicalPrd);
    if (input.identity !== identity) throw new PrdApprovalConflictError(input.identity, identity);
    if (run.status !== 'awaiting_approval') {
      const approval = await this.artifacts.getLatest(projectId, 'prd-approval');
      const approved = (approval?.content as { identity?: string } | undefined)?.identity;
      if (approved !== identity) {
        throw new ValidationError(`Run ${run.id} is not awaiting PRD approval.`);
      }
      // File-mode crash window: the run reached 'queued' but the project row
      // or queue publication may not have landed. Both writes are idempotent
      // (job id dedupe; status check), so replaying converges instead of
      // reporting success over missing state.
      if (run.status === 'queued') {
        let convergedProject = project;
        await this.transactionRunner.run(async (tx) => {
          if (project.status === 'awaiting_approval') {
            convergedProject = await this.projects.update(
              { ...project, status: 'queued', updatedAt: this.clock.now().toISOString() },
              project.version,
              tx,
            );
          }
          await this.queue.enqueue(runProjectJob(project, run, this.clock.now().toISOString()), tx);
        });
        return { project: convergedProject, run };
      }
      return { project, run };
    }
    const workflow = await this.workflows.get(project.workflowId);
    if (workflow.stack === 'nextjs') {
      const envelope = validateSupportedApplicationEnvelope(
        extractEnvelopeRequirements(canonicalPrd),
      );
      if (envelope.rejections.length > 0) {
        throw new ApplicationEnvelopeRejectedError(envelope.rejections);
      }
      if (envelope.questions.length > 0) {
        throw new ValidationError(
          'PRD approval is blocked while Blocking Questions remain unresolved.',
        );
      }
    }
    const now = this.clock.now().toISOString();
    // Outside the transaction for the same FK reason as create(); the
    // idempotency key makes a crash-then-retry converge on one approval.
    await this.artifacts.put({
      projectId,
      name: 'prd-approval',
      content: {
        schemaVersion: '1',
        identity,
        prdRevision: stored.metadata.revision,
        actor: input.actor,
        decidedAt: now,
      },
      createdBy: 'user',
      runId: run.id,
      idempotencyKey: identity,
    });
    // The run is pinned to the exact approved revision; execution loads the
    // PRD through this reference (sha256-verified), never through 'latest'.
    const queuedRun = transitionWorkflowRun(run, 'queued', this.clock.now(), {
      prd: {
        name: 'prd',
        revision: stored.metadata.revision,
        sha256: stored.metadata.sha256,
      },
    });
    let queuedProject: Project = { ...project, status: 'queued', updatedAt: now };
    try {
      await this.transactionRunner.run(async (tx) => {
        await this.appendEvent(
          projectId,
          'prd.approved',
          `PRD Revision ${stored.metadata.revision} approved for the run queue.`,
          {
            runId: run.id,
            dedupeKey: `${run.id}:prd.approved:${identity}`,
            data: { identity, revision: stored.metadata.revision },
            tx,
          },
        );
        await this.appendEvent(projectId, 'project.queued', 'Project queued for orchestration.', {
          runId: run.id,
          dedupeKey: `${run.id}:project.queued`,
          tx,
        });
        await this.runs.update(queuedRun, run.version, tx);
        queuedProject = await this.projects.update(queuedProject, project.version, tx);
        await this.queue.enqueue(runProjectJob(project, run, now), tx);
      });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      // The run row is the serialization point between approvePrd and
      // revisePrd. Losing the CAS means either a duplicate approval of the
      // same identity (converge to its outcome) or an interleaved revision
      // (surface the standard conflict instead of a raw version error).
      const latestRun = await this.requireRun(run.id);
      const latestProject = await this.requireProject(projectId);
      const approval = await currentPrdApproval(this.artifacts, projectId);
      if (latestRun.status === 'queued' && approval.approved && approval.identity === identity) {
        return { project: latestProject, run: latestRun };
      }
      throw new PrdApprovalConflictError(input.identity, approval.identity ?? identity);
    }
    return { project: queuedProject, run: queuedRun };
  }

  /**
   * Replaces the PRD with a new immutable revision while the run still awaits
   * approval (#602). Identical content is idempotent; a changed document gets
   * a new identity, so any approval of the old hash no longer matches.
   */
  async revisePrd(projectId: string, input: RevisePrdRequest): Promise<RevisePrdResponse> {
    const project = await this.requireProject(projectId);
    if (!project.currentRunId) {
      throw new ValidationError(`Project ${projectId} has no run awaiting PRD approval.`);
    }
    const run = await this.requireRun(project.currentRunId);
    if (run.status !== 'awaiting_approval') {
      throw new ValidationError('The PRD can only be revised while the run awaits PRD approval.');
    }
    const workflow = await this.workflows.get(project.workflowId);
    const validation = validateStandardPrd(input.prd);
    let canonicalPrd = input.prd;
    let questions: ApplicationEnvelopeQuestion[] = [];
    if (workflow.stack === 'nextjs') {
      if (!validation.ok) throw new StandardPrdRejectedError(validation.issues);
      canonicalPrd = validation.prd.canonicalMarkdown;
      const envelope = validateSupportedApplicationEnvelope(
        extractEnvelopeRequirements(canonicalPrd),
      );
      if (envelope.rejections.length > 0) {
        throw new ApplicationEnvelopeRejectedError(envelope.rejections);
      }
      questions = envelope.questions;
    } else if (!validation.ok) {
      const maxLengthIssues = validation.issues.filter((issue) => issue.code === 'max-length');
      if (maxLengthIssues.length > 0) throw new StandardPrdRejectedError(maxLengthIssues);
    }
    const current = await this.artifacts.getLatest(projectId, 'prd');
    if (!current) throw new NotFoundError(`Artifact prd not found in project ${projectId}`);
    const parentIdentity = prdIdentity(String(current.content));
    const identity = prdIdentity(canonicalPrd);
    if (identity === parentIdentity) {
      // Idempotent replay. A crash between the artifact write and the
      // workspace/event writes leaves exactly this state, so converge the
      // side effects (workspace copy, lineage/diff event) instead of
      // returning success over missing lineage.
      await this.reconcileRevisionReplay(projectId, run.id, current, questions);
      return { project, identity, revision: current.metadata.revision, questions };
    }
    // The run row serializes revisePrd against approvePrd and against
    // concurrent revisions: the loser of the CAS re-reads instead of racing.
    try {
      await this.transactionRunner.run(async (tx) => {
        await this.runs.update(
          { ...run, updatedAt: this.clock.now().toISOString() },
          run.version,
          tx,
        );
      });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      return this.convergeLostRevision(projectId, identity, questions, error);
    }
    let stored: StoredArtifact;
    try {
      stored = await this.artifacts.put({
        projectId,
        name: 'prd',
        content: canonicalPrd,
        contentType: 'text/markdown',
        createdBy: 'user',
        runId: run.id,
        expectedRevision: current.metadata.revision,
      });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      return this.convergeLostRevision(projectId, identity, questions, error);
    }
    await this.workspaces.writePrd(projectId, canonicalPrd);
    await this.appendRevisionEvents(projectId, run.id, {
      identity,
      parentIdentity,
      revision: stored.metadata.revision,
      diff: revisionDiff(
        current.metadata.revision,
        String(current.content),
        stored.metadata.revision,
        canonicalPrd,
      ),
      questions,
    });
    return { project, identity, revision: stored.metadata.revision, questions };
  }

  /**
   * Converges a revisePrd that lost the serialization CAS: a concurrent
   * submission of the same document reads as success (idempotent), anything
   * else surfaces the original conflict.
   */
  private async convergeLostRevision(
    projectId: string,
    identity: string,
    questions: ApplicationEnvelopeQuestion[],
    original: VersionConflictError,
  ): Promise<RevisePrdResponse> {
    const project = await this.requireProject(projectId);
    const run = project.currentRunId ? await this.runs.get(project.currentRunId) : null;
    if (!run || run.status !== 'awaiting_approval') {
      throw new ValidationError('The PRD can only be revised while the run awaits PRD approval.');
    }
    const latest = await this.artifacts.getLatest(projectId, 'prd');
    if (latest && prdIdentity(String(latest.content)) === identity) {
      await this.reconcileRevisionReplay(projectId, run.id, latest, questions);
      return { project, identity, revision: latest.metadata.revision, questions };
    }
    throw original;
  }

  /**
   * Replays the side effects of an already-stored revision — workspace copy
   * and lineage/diff + Blocking Questions events — all idempotent, so a
   * crash-interrupted or concurrent revisePrd always converges.
   */
  private async reconcileRevisionReplay(
    projectId: string,
    runId: string,
    stored: StoredArtifact,
    questions: ApplicationEnvelopeQuestion[],
  ): Promise<void> {
    await this.workspaces.writePrd(projectId, String(stored.content));
    // The initial document has no parent revision and its Blocking Questions
    // event was already emitted by create() under a run-scoped dedupe key.
    if (stored.metadata.revision <= 1) return;
    const parent = await this.artifacts.getRevision(projectId, 'prd', stored.metadata.revision - 1);
    if (!parent) return;
    await this.appendRevisionEvents(projectId, runId, {
      identity: prdIdentity(String(stored.content)),
      parentIdentity: prdIdentity(String(parent.content)),
      revision: stored.metadata.revision,
      diff: revisionDiff(
        parent.metadata.revision,
        String(parent.content),
        stored.metadata.revision,
        String(stored.content),
      ),
      questions,
    });
  }

  private async appendRevisionEvents(
    projectId: string,
    runId: string,
    input: {
      identity: string;
      parentIdentity: string;
      revision: number;
      diff: string;
      questions: ApplicationEnvelopeQuestion[];
    },
  ): Promise<void> {
    await this.appendEvent(
      projectId,
      'prd.revised',
      `PRD Revision ${input.revision} supersedes revision ${input.revision - 1}; any prior approval no longer applies.`,
      {
        runId,
        dedupeKey: `prd.revised:${input.identity}`,
        data: {
          identity: input.identity,
          parentIdentity: input.parentIdentity,
          revision: input.revision,
          diff: input.diff,
        },
      },
    );
    if (input.questions.length > 0) {
      await this.appendEvent(
        projectId,
        'prd.blocking_questions',
        'PRD has Blocking Questions; approval is blocked until a revision resolves them.',
        {
          runId,
          dedupeKey: `prd.blocking_questions:${input.identity}`,
          data: { questions: input.questions },
        },
      );
    }
  }

  async get(projectId: string): Promise<Omit<ProjectDetailResponse, 'knowledgeFiles'>> {
    const project = await this.requireProject(projectId);
    const [artifacts, events] = await Promise.all([
      this.artifacts.listLatest(projectId),
      this.events.list(projectId),
    ]);
    return { project, artifacts, events, workspacePath: this.workspaces.workspacePath(projectId) };
  }

  async list(limit = 50): Promise<Project[]> {
    return this.projects.list(limit);
  }

  /** Re-publishes deterministic jobs after a file-mode crash between queued state and enqueue. */
  async recoverQueuedProjects(): Promise<void> {
    for (const project of await this.projects.listAll()) {
      if (!project.currentRunId) continue;
      const run = await this.runs.get(project.currentRunId);
      if (!run) continue;
      const events = await this.events.list(project.id);
      const ready = events.some(
        (event) => event.dedupeKey === `${run.id}:project.initialization_ready`,
      );
      if (!ready) continue;
      if (project.status !== 'queued' || run.status !== 'queued') continue;
      // #602 fail-closed: a queued row without a current approval (legacy
      // state or corruption) is never republished — it converges to failed
      // with an explicit event instead of silently building an unapproved PRD.
      const approval = await currentPrdApproval(this.artifacts, project.id);
      if (!approval.approved || !approval.prd) {
        const message =
          'Queued run has no approval for the current PRD Revision; queue publication refused.';
        const failedRun = transitionWorkflowRun(run, 'failed', this.clock.now(), {
          error: { name: 'PrdApprovalMissingError', message },
        });
        await this.transactionRunner.run(async (tx) => {
          await this.runs.update(failedRun, run.version, tx);
          await this.projects.update(
            {
              ...project,
              status: 'failed',
              error: message,
              updatedAt: this.clock.now().toISOString(),
            },
            project.version,
            tx,
          );
          await this.appendEvent(project.id, 'project.queue_publication_refused', message, {
            runId: run.id,
            dedupeKey: `${run.id}:project.queue_publication_refused`,
            tx,
          });
        });
        continue;
      }
      // A pre-pin queued run gains its pin here so execution never falls back
      // to 'latest'.
      let recoveredRun = run;
      if (!run.prd) {
        recoveredRun = await this.runs.update(
          {
            ...run,
            prd: {
              name: 'prd',
              revision: approval.prd.metadata.revision,
              sha256: approval.prd.metadata.sha256,
            },
            updatedAt: this.clock.now().toISOString(),
          },
          run.version,
        );
      }
      await this.queue.enqueue(
        runProjectJob(project, recoveredRun, this.clock.now().toISOString()),
      );
      await this.appendEvent(
        project.id,
        'project.queued',
        'Project queue publication recovered after restart.',
        {
          runId: run.id,
          dedupeKey: `${run.id}:project.recovered_queued`,
        },
      );
    }
  }

  async getArtifact(projectId: string, name: string, revision?: number) {
    await this.requireProject(projectId);
    const artifact = revision
      ? await this.artifacts.getRevision(projectId, name, revision)
      : await this.artifacts.getLatest(projectId, name);
    if (!artifact) throw new NotFoundError(`Artifact ${name} not found in project ${projectId}`);
    return artifact;
  }

  async recordDelayedQualityObservation(
    projectId: string,
    input: QualityObservationInput,
  ): Promise<QualityObservation> {
    await this.requireProject(projectId);
    if (!this.qualityObservations) throw new Error('Quality observation service is not configured');
    const artifact = await this.artifacts.getRevision(
      projectId,
      input.artifact.name,
      input.artifact.revision,
    );
    if (!artifact || artifact.metadata.sha256 !== input.artifact.sha256) {
      throw new NotFoundError(
        `Artifact ${input.artifact.name} revision ${input.artifact.revision} not found in project ${projectId}`,
      );
    }
    const observation = await this.qualityObservations.recordDelayed(artifact, input);
    if (!observation) {
      throw new ValidationError(
        `Artifact ${input.artifact.name} revision ${input.artifact.revision} has no model route.`,
      );
    }
    return observation;
  }

  /**
   * Shared authorization/lookup step for both blob-serving routes: resolves
   * the project + artifact (throwing NotFoundError if either is missing) and
   * applies the one access rule that matters for blob access — an artifact
   * whose blob was already reaped reads as 'gone', not as its (now-stale)
   * metadata. getArtifactBlob and the /blob-url route's
   * getArtifactBlobMetadata both route through this, so neither can drift
   * out of sync on what "authorized" means.
   */
  async getArtifactBlobMetadata(
    projectId: string,
    name: string,
    revision?: number,
  ): Promise<ArtifactMetadata | 'gone'> {
    const artifact = await this.getArtifact(projectId, name, revision);
    return artifact.metadata.blobDeleted ? 'gone' : artifact.metadata;
  }

  async getArtifactBlob(
    projectId: string,
    name: string,
    revision?: number,
  ): Promise<{ metadata: ArtifactMetadata; stream: NodeJS.ReadableStream } | 'gone'> {
    const metadata = await this.getArtifactBlobMetadata(projectId, name, revision);
    if (metadata === 'gone') return 'gone';
    const stream = await this.artifacts.getBlobStream(projectId, metadata.name, metadata.revision);
    if (!stream) return 'gone';
    return { metadata, stream };
  }

  async retry(projectId: string, input?: RetryProjectRequest): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running' || project.status === 'queued') return project;
    const previousRun = project.currentRunId ? await this.runs.get(project.currentRunId) : null;
    if (
      project.error === INITIALIZATION_INTERRUPTED ||
      previousRun?.error?.name === 'ProjectInitializationError'
    ) {
      throw new ValidationError(
        'Project initialization failed; retry is blocked until workspace recovery is implemented.',
      );
    }
    // #602: retry is an enqueue surface, so PRD-backed projects obey the same
    // gate as approvePrd. Projects without a PRD artifact retain their
    // pre-#602 retry semantics.
    const approval = await currentPrdApproval(this.artifacts, projectId);
    if (approval.prd && previousRun?.status === 'awaiting_approval') {
      if (input?.prompt) {
        await this.revisePrd(projectId, { prd: input.prompt });
        return this.requireProject(projectId);
      }
      throw new ValidationError(
        `Run ${previousRun.id} is awaiting PRD approval; approve the current PRD Revision instead of retrying.`,
      );
    }
    if (approval.prd && (input?.prompt || !approval.approved)) {
      const reopened = await this.reopenForApproval(project, previousRun, input);
      if (input?.prompt) {
        await this.revisePrd(projectId, { prd: input.prompt });
        return this.requireProject(projectId);
      }
      return reopened;
    }
    if (input?.prompt && !approval.prd) {
      await this.workspaces.writePrd(projectId, input.prompt);
    }
    const prdReference: ArtifactReference | undefined = approval.prd
      ? {
          name: 'prd',
          revision: approval.prd.metadata.revision,
          sha256: approval.prd.metadata.sha256,
        }
      : undefined;
    const now = this.clock.now().toISOString();
    const campaignPreview = previousRun?.execution?.campaign?.preview ?? this.validationCampaign;
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(prdReference ? { prd: prdReference } : {}),
      ...(campaignPreview
        ? {
            execution: {
              activeElapsedMs: 0,
              consecutiveRepairs: 0,
              campaign: createValidationCampaignExecution(campaignPreview),
            },
          }
        : {}),
    };
    await this.runs.create(run);
    // Created before the job is enqueued so the override is already visible
    // to the router by the time any worker could possibly claim the job —
    // no race window like there would be creating it after the fact.
    // createModelOverride writes through ModelOverrideRepository, which is
    // permanently file-based regardless of PERSISTENCE_MODE (see runtime.ts)
    // -- it can never join the Postgres transaction below, so this call and
    // runs.create above both stay outside/before it.
    if (input?.override) {
      await this.createModelOverride(runId, { ...input.override, scope: { kind: 'run' } });
    }
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;

    return this.transactionRunner.run(async (tx) => {
      const saved = await this.projects.update(updated, project.version, tx);
      await this.queue.enqueue(runProjectJob(saved, run, now), tx);
      await this.appendEvent(projectId, 'project.queued', 'Project manually re-queued.', { tx });
      return saved;
    });
  }

  /**
   * Fail-closed retry path (#602): without a current approval nothing may be
   * queued, so retry re-arms the approval flow with a fresh run instead of
   * publishing a job. approvePrd (or revisePrd + approvePrd) is the only way
   * forward from here.
   */
  private async reopenForApproval(
    project: Project,
    previousRun: WorkflowRun | null,
    input?: RetryProjectRequest,
  ): Promise<Project> {
    const now = this.clock.now().toISOString();
    const campaignPreview = previousRun?.execution?.campaign?.preview ?? this.validationCampaign;
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId: project.id,
      workflowId: project.workflowId,
      status: 'awaiting_approval',
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...(campaignPreview
        ? {
            execution: {
              activeElapsedMs: 0,
              consecutiveRepairs: 0,
              campaign: createValidationCampaignExecution(campaignPreview),
            },
          }
        : {}),
    };
    await this.runs.create(run);
    if (input?.override) {
      await this.createModelOverride(runId, { ...input.override, scope: { kind: 'run' } });
    }
    const updated: Project = {
      ...project,
      status: 'awaiting_approval',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;
    return this.transactionRunner.run(async (tx) => {
      const saved = await this.projects.update(updated, project.version, tx);
      await this.appendEvent(
        project.id,
        'prd.approval_reopened',
        'Retry reopened PRD approval; nothing was queued.',
        { runId, dedupeKey: `${runId}:prd.approval_reopened`, tx },
      );
      return saved;
    });
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
        await this.appendEvent(run.projectId, 'run.cancel_requested', 'Cancellation requested.', {
          runId,
        });
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
          { runId },
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
        { runId, data: { diagnostics } },
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
      { runId, data: resumeNodeId ? { resumeNodeId } : {} },
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
      // Projected straight from the ADR-0073 Call Budget ledger (#604) in
      // `run.execution.callBudget` — never recomputed by scanning
      // StepAttempts, which is not atomic against concurrent reservations.
      budget: Object.values(run.execution?.callBudget ?? {}),
    };
  }

  /** The diff between the last verified checkpoint and a ceiling-preserved draft, for UI inspection. */
  async getDraft(runId: string): Promise<DraftDetailResponse> {
    const run = await this.requireRun(runId);
    const ceiling = run.execution?.ceiling;
    const verifiedCheckpoint = run.execution?.lastVerifiedCheckpoint;
    if (!ceiling?.draftBranch || !verifiedCheckpoint) {
      throw new NotFoundError(`Run ${runId} has no preserved draft`);
    }
    const diff = await this.workspaces.diff(run.projectId, verifiedCheckpoint, ceiling.draftBranch);
    return { draftBranch: ceiling.draftBranch, diff };
  }

  /**
   * Deletes a preserved draft's git branch and records who did it and when,
   * as a `run.draft_discarded` ProjectEvent — the durable audit trail this
   * codebase already uses for approval decisions and ceiling events.
   * Idempotent: discarding an already-discarded draft is a no-op.
   */
  async discardDraft(runId: string, input: DiscardDraftRequest): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    const ceiling = run.execution?.ceiling;
    if (!ceiling?.draftBranch || !ceiling.draftCommit) {
      throw new NotFoundError(`Run ${runId} has no preserved draft`);
    }
    if (ceiling.discardedAt) return run;

    await this.workspaces.discardDraft(run.projectId, runId, ceiling.draftCommit);
    const now = this.clock.now().toISOString();
    const updated = await this.runs.update(
      {
        ...run,
        execution: {
          ...run.execution!,
          ceiling: { ...ceiling, discardedAt: now, discardedBy: input.actor },
        },
        updatedAt: now,
      },
      run.version,
    );
    await this.appendEvent(
      run.projectId,
      'run.draft_discarded',
      `Draft ${ceiling.draftBranch} discarded by ${input.actor.displayName ?? input.actor.id}.`,
      {
        runId,
        data: {
          draftBranch: ceiling.draftBranch,
          discardedBy: input.actor,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      },
    );
    return updated;
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
    const checkpoint = await this.retryCheckpoint(runId, target.id);
    return {
      target,
      downstream,
      artifacts: [...artifacts].sort(),
      ...(checkpoint ? { checkpoint } : {}),
    };
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
      const workflow = await this.workflows.get(run.workflowId);
      if (!isAgentStep(workflow, target.nodeId, target.stepId)) {
        throw new ValidationError(
          `Step run ${stepRunId} is not an agent step; only agent steps support model overrides.`,
        );
      }
      const match = await this.resolveCatalogModel(
        input.override.modelId,
        input.override.provider,
        input.override.model,
      );
      const audit = redactOverrideAudit(input.override);
      override = {
        modelId: match.id,
        provider: match.provider,
        model: match.model,
        ...audit,
      };
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
      {
        runId,
        data: {
          stepRunId,
          mode: input.mode,
          ...(override ? { override } : {}),
          invalidatedStepRunIds,
        },
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
    retry = 0,
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
        ...(input.note ? { note: input.note } : {}),
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
    const nodeNotFound = () =>
      new NotFoundError(
        `Approval gate node ${request.nodeId} not found in workflow ${run.workflowId}`,
      );
    // A dynamic gate (#535's destructive-migration approval) is raised
    // mid-step rather than declared as a static `approval-gate` workflow
    // node, so its reserved id shape is authoritative — never looked up in
    // `workflow.nodes`, which a same-named real node could otherwise shadow.
    // It only ever offers approve/reject with no return-to-step.
    const dynamicGate = isMigrationApprovalGateId(request.nodeId);
    const found = dynamicGate
      ? undefined
      : workflow.nodes.find((candidate) => candidate.id === request.nodeId);
    if (!dynamicGate && (!found || found.type !== 'approval-gate')) {
      throw nodeNotFound();
    }
    // Narrowed separately from `found` so TS carries the discriminated
    // `approval-gate` type across the guard above, which it can't do
    // through a condition that also depends on `dynamicGate`.
    const node = found?.type === 'approval-gate' ? found : undefined;

    // Everything below acts on the settled `decision` record, not `input` —
    // on the crash-recovery path the retry's input may differ (e.g. a
    // different caller), and the originally recorded decision must win.
    const needsReturn =
      decision.action === 'request-changes' ||
      (decision.action === 'reject' && node?.onReject === 'return-to-step');

    let updatedRun: WorkflowRun;
    if (needsReturn) {
      // A dynamic gate never allows 'request-changes' and never sets
      // onReject: 'return-to-step', so needsReturn is unreachable without a
      // real node — this is a defensive invariant check, not live behavior.
      if (!node) throw nodeNotFound();
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
        const stored = await this.artifacts.put({
          projectId: run.projectId,
          name: node.repairArtifact,
          content: FeedbackArtifactSchema.parse({
            schemaVersion: '1',
            actor: decision.actor ?? { kind: 'user', id: decision.decidedBy },
            sourceRequestId: request.id,
            sourceDecisionId: decision.id,
            runId,
            stepRunId: request.stepRunId,
            note: decision.note ?? '',
            createdAt: decision.decidedAt,
          }),
          createdBy: `approval-gate:${node.id}`,
          runId,
          stepRunId: request.stepRunId,
          kind: 'feedback',
          actor: decision.actor ?? { kind: 'user', id: decision.decidedBy },
          sourceDecisionId: decision.id,
        });
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
      try {
        updatedRun = await this.runs.update(
          // Clears any stale retry directive left by an earlier request-changes
          // cycle on this same run — otherwise a later replay could mistake an
          // already-superseded step for the current retry target.
          transitionWorkflowRun(run, 'queued', this.clock.now(), { retry: undefined }),
          run.version,
        );
      } catch (error) {
        if (!(error instanceof VersionConflictError) || retry >= 2) throw error;
        const current = await this.requireRun(runId);
        if (current.status === 'queued') return { run: current, decision };
        if (current.status !== 'awaiting_approval') throw error;
        return this.decideApproval(runId, requestId, input, retry + 1);
      }
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

  /** The checkpoint a retry rolls back to — previewed by retryPlan, executed by invalidateFromStep. */
  private async retryCheckpoint(runId: string, stepRunId: string): Promise<string | undefined> {
    const attempts = await this.stepAttempts.list(runId, stepRunId);
    return attempts.filter((attempt) => attempt.checkpoint).at(-1)?.checkpoint;
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
    const checkpoint = await this.retryCheckpoint(run.id, target.id);
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
    // Only the resuming node's declared inputs are the world it resumes into;
    // artifacts written by sibling services while paused are not drift (#319).
    // A pause acked before the graph walk has no resumeNodeId — any node may
    // execute next, so fall back to every node's declared inputs.
    const resumeNode = workflow.nodes.find((node) => node.id === snapshot.resumeNodeId);
    const inputNames = resumeNode
      ? nodeInputArtifactNames(resumeNode)
      : workflow.nodes.flatMap(nodeInputArtifactNames);
    if (inputNames.length === 0) return diagnostics;
    const latest = latestArtifactsByName(await this.artifacts.listMetadata(run.projectId));
    for (const name of [...new Set(inputNames)].sort()) {
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
    const job: QueueJob = {
      id: jobId ?? `run-project-${runId}`,
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: RUN_PROJECT_MAX_ATTEMPTS,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
      ...traceContextField(),
    };
    await this.transactionRunner.run(async (tx) => {
      if (project.status !== 'queued' || project.currentRunId !== runId) {
        const updated: Project = {
          ...project,
          status: 'queued',
          updatedAt: now,
          currentRunId: runId,
        };
        delete updated.error;
        await this.projects.update(updated, project.version, tx);
      }
      await this.queue.enqueue(job, tx);
    });
  }

  private async markInitializationFailed(
    projectId: string,
    runId: string,
    message: string,
  ): Promise<void> {
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < INITIALIZATION_FAILURE_ATTEMPTS; attempt += 1) {
      try {
        await this.transactionRunner.run(async (tx) => {
          const [project, run] = await Promise.all([
            this.projects.get(projectId),
            this.runs.get(runId),
          ]);
          if (run && (run.status !== 'failed' || run.error?.message !== message)) {
            const failedRun =
              run.status === 'failed'
                ? {
                    ...run,
                    error: { name: 'ProjectInitializationError' as const, message },
                    updatedAt: this.clock.now().toISOString(),
                  }
                : transitionWorkflowRun(run, 'failed', this.clock.now(), {
                    error: { name: 'ProjectInitializationError', message },
                  });
            await this.runs.update(failedRun, run.version, tx);
          }
          if (project && (project.status !== 'failed' || project.error !== message)) {
            await this.projects.update(
              {
                ...project,
                status: 'failed',
                error: message,
                updatedAt: this.clock.now().toISOString(),
              },
              project.version,
              tx,
            );
          }
          if (project && run) {
            await this.appendEvent(projectId, 'project.failed', message, {
              runId,
              dedupeKey: `${runId}:project.initialization_failed`,
              tx,
            });
          }
        });
        return;
      } catch (error) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, `Project ${projectId} initialization compensation failed.`);
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
      {
        runId: run.id,
        data: {
          requestId,
          action: decision.action,
          decidedBy: decision.decidedBy,
          // The operator's comment is mandatory for request-changes and the
          // recorded reason for reject; the timeline is where it is read.
          ...(decision.note ? { note: decision.note } : {}),
          ...(decision.actor ? { actor: decision.actor } : {}),
        },
        dedupeKey: `approval-decision:${decision.id}`,
      },
    );
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  private async resolveCatalogModel(
    modelId: string,
    provider: Provider,
    model: string,
  ): Promise<ModelDefinition> {
    const match = (await this.router.catalog()).find((candidate) => candidate.id === modelId);
    if (!match || !match.enabled) {
      throw new ValidationError(`Catalog model ${modelId} is not enabled.`);
    }
    if (match.provider !== provider || match.model !== model) {
      throw new ValidationError(
        `Override model ${modelId} catalog tuple changed: expected ${provider}/${model}, found ${match.provider}/${match.model}.`,
      );
    }
    return match;
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
    options: { runId?: string; data?: Record<string, unknown>; dedupeKey?: string; tx?: Tx } = {},
  ): Promise<void> {
    const { runId, data = {}, dedupeKey, tx } = options;
    await this.events.append(
      {
        id: this.ids.next(),
        projectId,
        type,
        createdAt: this.clock.now().toISOString(),
        ...(runId ? { runId } : {}),
        message,
        data,
        ...(dedupeKey ? { dedupeKey } : {}),
      },
      tx,
    );
  }
}

/** Artifact names a node reads when it executes — the inputs resume must prove unchanged. */
function nodeInputArtifactNames(node: WorkflowNode): string[] {
  switch (node.type) {
    case 'agent':
      return node.inputArtifacts;
    case 'verify':
      return node.browserTestPlanArtifact ? [node.browserTestPlanArtifact] : [];
    case 'approval-gate':
      return [node.artifact];
    case 'quality-loop':
      return [
        ...(node.setup ? nodeInputArtifactNames(node.setup) : []),
        ...nodeInputArtifactNames(node.check),
        ...node.repair.inputArtifacts,
        node.approval.artifact,
      ];
    case 'for-each-task':
      return [node.taskGraphArtifact, ...node.implement.inputArtifacts];
    default:
      return node satisfies never;
  }
}

function isAgentStep(workflow: WorkflowDefinition, nodeId: string, stepId: string): boolean {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  return (
    (node?.type === 'agent' && node.id === stepId) ||
    (node?.type === 'quality-loop' &&
      [node.setup, node.check, node.repair].some(
        (step) => step?.type === 'agent' && step.id === stepId,
      )) ||
    // A for-each-task node runs its implement and repair steps once per task
    // under the per-task id `<step>.<taskId>`, so both forms are pinnable.
    (node?.type === 'for-each-task' &&
      [node.implement, node.repair, node.browser?.plan].some(
        (step) => step !== undefined && isTaskStepId(stepId, step.id),
      )) ||
    // The browser loop runs repair under its own declared id (#325).
    (node?.type === 'for-each-task' &&
      node.repair !== undefined &&
      isTaskStepId(stepId, browserRepairId(node.repair.id)))
  );
}

function redactOverrideAudit(input: { actor: ActorRef; reason: string; estimatedImpact: string }): {
  actor: ActorRef;
  reason: string;
  estimatedImpact: string;
} {
  return {
    actor: {
      ...input.actor,
      id: redactString(input.actor.id).trim() || '[REDACTED]',
      ...(input.actor.displayName
        ? { displayName: redactString(input.actor.displayName).trim() || '[REDACTED]' }
        : {}),
    },
    reason: redactString(input.reason).trim() || '[REDACTED]',
    estimatedImpact: redactString(input.estimatedImpact).trim() || '[REDACTED]',
  };
}
