import { createHash } from 'node:crypto';
import {
  ValidationEvidenceBundleSchema,
  BrowserVerificationReportSchema,
  BrowserTestPlanArtifactSchema,
  GeneratedTaskGraphArtifactSchema,
  ValidationEvidencePublicationRequestSchema,
  ValidationOperatorAcceptanceRequestSchema,
  ValidationEvidenceResponseSchema,
  ValidationDatabaseEvidenceSchema,
  VerificationReportSchema,
  type ArtifactReference,
  type BrowserTestPlan,
  type BrowserVerificationReport,
  type StepAttempt,
  type ValidationEvidenceAttempt,
  type ValidationEvidenceBundle,
  type ValidationEvidenceGateId,
  type ValidationEvidenceFailureClass,
  type ValidationEvidencePublicationRequest,
  type ValidationOperatorAcceptanceRequest,
  type ValidationEvidenceReference,
  type ValidationEvidenceResponse,
  type ValidationEvidenceTerminalState,
  type ValidationPreflightReport,
  type StoredArtifact,
  type ProjectEvent,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  EventStore,
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import {
  NotFoundError,
  redactPersonalPaths,
  redactString,
  redactUnknown,
  ValidationError,
} from '@agent-foundry/domain';
import { summarizeValidationUsage } from './validation-budget.js';
import { validateBrowserVerificationReportBinding } from './browser-verification-coordinator.js';

const EVIDENCE_ARTIFACT_PREFIX = 'validation-evidence-';

export interface ValidationEvidencePublisher {
  publishFromRun(runId: string): Promise<ValidationEvidenceResponse | null>;
}

export class ValidationEvidenceService {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly preflightReport?: (
      runId: string,
    ) => Promise<ValidationPreflightReport | undefined>,
  ) {}

  async publish(
    runId: string,
    input: ValidationEvidencePublicationRequest,
  ): Promise<ValidationEvidenceResponse> {
    const run = await this.requireRun(runId);
    const parsedInput = ValidationEvidencePublicationRequestSchema.parse(input);
    const trustedPreflight = await this.trustedPreflight(run);
    return this.publishParsed(run, parsedInput, trustedPreflight, false);
  }

  async acceptOperator(
    runId: string,
    input: ValidationOperatorAcceptanceRequest,
  ): Promise<{ runId: string; acceptedAt: string }> {
    const run = await this.requireRun(runId);
    if (!run.execution?.campaign) {
      throw new ValidationError(`Run ${runId} is not attached to a validation campaign.`);
    }
    const acceptance = ValidationOperatorAcceptanceRequestSchema.parse(input);
    for (const [name, reference] of [
      ['browser-verification.report', acceptance.browserArtifact],
      ['database.evidence', acceptance.databaseArtifact],
    ] as const) {
      if (reference.name !== name) {
        throw new ValidationError(`Operator acceptance requires ${name} evidence.`);
      }
      await this.validateArtifactReference(run, { runId, artifact: reference }, true);
    }
    const acceptedAt = new Date().toISOString();
    const acceptanceKey = createHash('sha256')
      .update(JSON.stringify({ runId, ...acceptance }))
      .digest('hex');
    await this.events.append({
      id: `validation-operator-accepted-${acceptanceKey.slice(0, 32)}`,
      projectId: run.projectId,
      runId,
      type: 'validation.operator_accepted',
      createdAt: acceptedAt,
      message: 'Operator accepted the visible TODO and matching database row.',
      dedupeKey: `validation-operator-accepted:${acceptanceKey}`,
      data: {
        decidedBy: acceptance.decidedBy,
        browserArtifact: acceptance.browserArtifact,
        databaseArtifact: acceptance.databaseArtifact,
      },
    });
    return { runId, acceptedAt };
  }

  private async publishParsed(
    run: WorkflowRun,
    parsedInput: ValidationEvidencePublicationRequest,
    trustedPreflight: ValidationPreflightReport | undefined,
    automaticCapture: boolean,
  ): Promise<ValidationEvidenceResponse> {
    const campaign = run.execution?.campaign;
    if (!campaign) {
      throw new ValidationError(`Run ${run.id} is not attached to a validation campaign.`);
    }

    await this.validateReferences(run, parsedInput);
    const attempts = await this.listRunAttempts(run.id);
    await this.validateAttemptArtifactReferences(run, attempts);
    const operatorAccepted = await this.hasOperatorAcceptance(run, parsedInput);
    const outcome = classifyOutcome(
      run,
      parsedInput,
      attempts.length,
      automaticFailureClass(run, attempts),
      trustedPreflight,
      automaticCapture,
      operatorAccepted,
    );
    if (outcome === 'accepted') {
      await this.validateAcceptedRuntime(run, parsedInput, attempts);
    }
    const publication =
      automaticCapture && !operatorAccepted && outcome === 'product-failed'
        ? markOperatorAcceptancePending(parsedInput)
        : parsedInput;
    const bundle = buildValidationEvidenceBundle({
      run,
      campaignId: campaign.preview.id,
      sourceRevision: campaign.preview.sourceRevision,
      input: publication,
      attempts,
      publishedAt: new Date().toISOString(),
      ...(trustedPreflight ? { trustedPreflight } : {}),
      automaticCapture,
      operatorAccepted,
    });
    const artifact = await this.artifacts.put({
      projectId: run.projectId,
      name: evidenceArtifactName(campaign.preview.id),
      content: bundle,
      createdBy: `validation-campaign:${campaign.preview.id}`,
      runId: run.id,
      idempotencyKey: evidenceIdempotencyKey(campaign.preview.id, run.id, publication),
    });
    return ValidationEvidenceResponseSchema.parse({
      bundle: ValidationEvidenceBundleSchema.parse(artifact.content),
      artifact,
    });
  }

  async publishFromRun(runId: string): Promise<ValidationEvidenceResponse | null> {
    const run = await this.requireRun(runId);
    if (!run.execution?.campaign) return null;
    const attempts = await this.listRunAttempts(runId);
    const trustedPreflight = await this.trustedPreflight(run);
    return this.publishParsed(
      run,
      await this.capturePublication(run, attempts),
      trustedPreflight,
      true,
    );
  }

  async get(runId: string): Promise<ValidationEvidenceResponse> {
    const run = await this.requireRun(runId);
    const campaign = run.execution?.campaign;
    if (!campaign) {
      throw new ValidationError(`Run ${runId} is not attached to a validation campaign.`);
    }
    const name = evidenceArtifactName(campaign.preview.id);
    const metadata = (await this.artifacts.listMetadata(run.projectId, name))
      .filter((item) => item.runId === runId)
      .at(-1);
    const artifact = metadata
      ? await this.artifacts.getRevision(run.projectId, name, metadata.revision)
      : null;
    if (!artifact) throw new NotFoundError(`Validation evidence for run ${runId} not found`);
    return ValidationEvidenceResponseSchema.parse({
      bundle: ValidationEvidenceBundleSchema.parse(artifact.content),
      artifact,
    });
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Run ${runId} not found`);
    return run;
  }

  private async trustedPreflight(run: WorkflowRun): Promise<ValidationPreflightReport | undefined> {
    const candidate = await this.preflightReport?.(run.id);
    const campaign = run.execution?.campaign?.preview;
    return candidate &&
      campaign &&
      candidate.campaignId === campaign.id &&
      candidate.sourceRevision === campaign.sourceRevision
      ? candidate
      : undefined;
  }

  private async listRunAttempts(runId: string): Promise<StepAttempt[]> {
    const steps = await this.stepRuns.list(runId);
    const attempts = await Promise.all(steps.map((step) => this.stepAttempts.list(runId, step.id)));
    return attempts.flat().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async validateReferences(
    run: WorkflowRun,
    input: ValidationEvidencePublicationRequest,
  ): Promise<void> {
    for (const gate of input.gates) {
      for (const reference of gate.references) {
        if (reference.runId !== run.id) {
          throw new ValidationError(
            `Evidence reference belongs to another run: ${reference.runId}`,
          );
        }
        if (reference.stepRunId) {
          const step = await this.stepRuns.get(run.id, reference.stepRunId);
          if (!step) throw new ValidationError(`Evidence step ${reference.stepRunId} not found`);
        }
        if (reference.attemptId) {
          if (!reference.stepRunId) {
            throw new ValidationError('An attempt evidence reference requires stepRunId');
          }
          const attempt = await this.stepAttempts.get(
            run.id,
            reference.stepRunId,
            reference.attemptId,
          );
          if (!attempt)
            throw new ValidationError(`Evidence attempt ${reference.attemptId} not found`);
        }
        if (reference.artifact) {
          const artifactReference = reference.artifact;
          await this.validateArtifactReference(run, reference);
          if (reference.stepRunId && reference.attemptId) {
            const attempt = await this.stepAttempts.get(
              run.id,
              reference.stepRunId,
              reference.attemptId,
            );
            if (
              !attempt?.outputArtifacts.some((artifact) =>
                sameArtifactReference(artifactReference, artifact),
              )
            ) {
              throw new ValidationError(
                `Evidence artifact ${artifactReference.name}@${artifactReference.revision} is not an output of attempt ${reference.attemptId}`,
              );
            }
          }
        }
      }
    }
  }

  private async validateAttemptArtifactReferences(
    run: WorkflowRun,
    attempts: readonly StepAttempt[],
  ): Promise<void> {
    for (const attempt of attempts) {
      for (const artifact of attempt.inputArtifacts) {
        await this.validateArtifactReference(run, { runId: attempt.runId, artifact }, true);
      }
      for (const artifact of attempt.outputArtifacts) {
        await this.validateArtifactReference(run, {
          runId: attempt.runId,
          stepRunId: attempt.stepRunId,
          attemptId: attempt.id,
          artifact,
        });
      }
    }
  }

  private async validateAcceptedRuntime(
    run: WorkflowRun,
    input: ValidationEvidencePublicationRequest,
    attempts: readonly StepAttempt[],
  ): Promise<void> {
    const events = await this.events.list(run.projectId);
    const runEvents = events.filter((event) => event.runId === run.id);
    const gate = (id: ValidationEvidenceGateId) =>
      input.gates.find((candidate) => candidate.id === id);
    const artifactReferences = (id: ValidationEvidenceGateId) =>
      gate(id)?.references.flatMap((reference) =>
        reference.artifact ? [reference.artifact] : [],
      ) ?? [];
    const hasName = (id: ValidationEvidenceGateId, names: readonly string[]) => {
      const references = artifactReferences(id);
      return references.length === 1 && names.includes(references[0]?.name ?? '');
    };
    const hasProducedArtifact = async (
      id: ValidationEvidenceGateId,
      names: readonly string[],
    ): Promise<boolean> => {
      const [reference] = artifactReferences(id);
      if (
        !reference ||
        !names.includes(reference.name) ||
        !hasArtifactCreatedEvent(runEvents, reference)
      ) {
        return false;
      }
      const artifact = await this.artifacts.getRevision(
        run.projectId,
        reference.name,
        reference.revision,
      );
      const producer =
        artifact?.metadata.stepRunId && artifact.metadata.attemptId
          ? await this.stepAttempts.get(
              run.id,
              artifact.metadata.stepRunId,
              artifact.metadata.attemptId,
            )
          : undefined;
      return Boolean(
        artifact &&
        artifact.metadata.runId === run.id &&
        artifact.metadata.sha256 === reference.sha256 &&
        producer?.status === 'succeeded' &&
        producer.outputArtifacts.some((candidate) => sameArtifactReference(reference, candidate)),
      );
    };
    const hasApprovedDeterministic = async (id: ValidationEvidenceGateId) => {
      const [reference] = artifactReferences(id);
      if (!reference || !hasArtifactCreatedEvent(runEvents, reference)) return false;
      const artifact = await this.artifacts.getRevision(
        run.projectId,
        reference.name,
        reference.revision,
      );
      const report = artifact ? VerificationReportSchema.safeParse(artifact.content) : null;
      return Boolean(
        report?.success &&
        report.data.approved &&
        hasApprovedVerificationEvent(runEvents, reference, 'verification.report'),
      );
    };
    const hasApprovedBrowser = async (id: ValidationEvidenceGateId) => {
      const [reference] = artifactReferences(id);
      if (!reference || !hasArtifactCreatedEvent(runEvents, reference)) return false;
      const artifact = await this.artifacts.getRevision(
        run.projectId,
        reference.name,
        reference.revision,
      );
      return Boolean(
        (await this.isApprovedBrowserEvidence(run, artifact)) &&
        hasApprovedVerificationEvent(runEvents, reference, 'browser-verification.report'),
      );
    };
    const hasHealthyPreview = async () => {
      const [reference] = artifactReferences('preview-healthy');
      if (!reference || !hasArtifactCreatedEvent(runEvents, reference)) return false;
      const artifact = await this.artifacts.getRevision(
        run.projectId,
        reference.name,
        reference.revision,
      );
      const report = BrowserVerificationReportSchema.safeParse(artifact?.content);
      return Boolean(
        report?.success &&
        report.data.previewSession.status === 'running' &&
        (await this.isApprovedBrowserEvidence(run, artifact)) &&
        hasApprovedVerificationEvent(runEvents, reference, 'browser-verification.report'),
      );
    };
    const hasDatabaseProof = async () => {
      const verificationArtifact = artifactReferences('deterministic-checks')[0];
      const [databaseReference] = artifactReferences('database-match');
      if (
        !verificationArtifact ||
        !databaseReference ||
        !hasArtifactCreatedEvent(runEvents, databaseReference)
      ) {
        return false;
      }
      const [database, verification] = await Promise.all([
        this.artifacts.getRevision(
          run.projectId,
          databaseReference.name,
          databaseReference.revision,
        ),
        this.artifacts.getRevision(
          run.projectId,
          verificationArtifact.name,
          verificationArtifact.revision,
        ),
      ]);
      const browserRef = databaseEvidenceBrowserRef(database, verificationArtifact, verification);
      return Boolean(browserRef && (await this.isPersistedApprovedBrowserReport(run, browserRef)));
    };
    const approvedPlan = artifactReferences('plan-approved')[0];
    const hasApprovedPlan = Boolean(
      approvedPlan &&
      runEvents.some(
        (event) =>
          event.type === 'run.approval_decided' &&
          event.data.action === 'approve' &&
          sameArtifactReference(approvedPlan, event.data.reviewedArtifact),
      ),
    );
    const approvedPlanArtifact = approvedPlan
      ? await this.artifacts.getRevision(run.projectId, approvedPlan.name, approvedPlan.revision)
      : null;
    const approvedPlanGraph = approvedPlanArtifact
      ? GeneratedTaskGraphArtifactSchema.safeParse(approvedPlanArtifact.content)
      : null;
    // The approved plan's own task count is the source of truth: the PRD
    // evolved from the original 3-task shape to require the middleware
    // exclusion as its own dependency task (#398), and the plan gate already
    // bounds what the operator approves.
    const hasApprovedPlanGraph = Boolean(
      approvedPlanGraph?.success && approvedPlanGraph.data.data.tasks.length > 0,
    );
    const missing: string[] = [];
    if (
      !runEvents.some((event) => event.type === 'project.created') ||
      !hasName('project-created', ['prd', 'scaffold-manifest'])
    ) {
      missing.push('project-created');
    }
    if (!hasApprovedPlan || !hasApprovedPlanGraph || !hasName('plan-approved', ['plan.current'])) {
      missing.push('plan-approved');
    }
    if (
      !(await hasProducedArtifact('implementation-generated', ['implementation.report'])) ||
      !hasName('implementation-generated', ['implementation.report'])
    ) {
      missing.push('implementation-generated');
    }
    if (
      !hasName('deterministic-checks', ['verification.report']) ||
      !(await hasApprovedDeterministic('deterministic-checks'))
    ) {
      missing.push('deterministic-checks');
    }
    if (
      !runEvents.some((event) => event.type === 'project.provisioned') ||
      !hasName('preview-healthy', ['browser-verification.report']) ||
      !(await hasHealthyPreview())
    ) {
      missing.push('preview-healthy');
    }
    if (
      !hasName('browser-acceptance', ['browser-verification.report']) ||
      !(await hasApprovedBrowser('browser-acceptance'))
    ) {
      missing.push('browser-acceptance');
    }
    if (!(await hasDatabaseProof())) {
      missing.push('database-match');
    }
    if (!(await this.hasOperatorAcceptance(run, input))) missing.push('operator-acceptance');
    if (run.status !== 'completed' || !run.completedAt) missing.push('terminal-run');
    const taskStepRuns = await this.stepRuns.list(run.id);
    const checkpointedTaskIds = new Set(
      attempts
        .filter((attempt) => attempt.status === 'succeeded' && attempt.checkpoint)
        .flatMap((attempt) => {
          const stepRun = taskStepRuns.find((candidate) => candidate.id === attempt.stepRunId);
          return approvedPlanGraph?.success
            ? approvedPlanGraph.data.data.tasks
                .filter((task) => stepRun?.stepId.endsWith(`.${task.id}`))
                .map((task) => task.id)
            : [];
        }),
    );
    if (
      !approvedPlanGraph?.success ||
      checkpointedTaskIds.size !== approvedPlanGraph.data.data.tasks.length
    ) {
      missing.push('checkpoints');
    }
    if (missing.length > 0) {
      throw new ValidationError(
        `Accepted evidence is not proven by persisted runtime evidence: ${missing.join(', ')}`,
      );
    }
  }

  private async capturePublication(
    run: WorkflowRun,
    attempts: readonly StepAttempt[],
  ): Promise<ValidationEvidencePublicationRequest> {
    const preflight = await this.trustedPreflight(run);
    const environmentReadiness = preflight
      ? {
          status: preflight.status,
          environmentId: preflight.environmentId,
          checks: preflight.checks.map((check) => ({
            boundary: check.boundary,
            status: check.status,
            durationMs: check.durationMs,
            ...(check.message ? { message: check.message } : {}),
            ...(check.errorCode ? { errorCode: check.errorCode } : {}),
            ...(check.provider ? { provider: check.provider } : {}),
            ...(check.selectedModel ? { selectedModel: check.selectedModel } : {}),
            ...(check.executedModel ? { executedModel: check.executedModel } : {}),
          })),
        }
      : {
          status: 'environment-blocked' as const,
          environmentId: `validation-run-${run.id}`,
          checks: [
            {
              boundary: 'source-revision' as const,
              status: 'failed' as const,
              durationMs: 0,
              message: 'No validation preflight report was available for this run.',
              errorCode: 'PREFLIGHT_NOT_RUN',
            },
          ],
        };
    const events = await this.events.list(run.projectId);
    const runEvents = events.filter((event) => event.runId === run.id);
    const latest = async (names: readonly string[]) => {
      const metadata = (await this.artifacts.listMetadata(run.projectId))
        .filter((item) => names.includes(item.name) && item.runId === run.id)
        .at(-1);
      return metadata
        ? this.artifacts.getRevision(run.projectId, metadata.name, metadata.revision)
        : null;
    };
    const reference = (artifact: Awaited<ReturnType<typeof latest>>) =>
      artifact
        ? {
            runId: run.id,
            ...(artifact.metadata.stepRunId ? { stepRunId: artifact.metadata.stepRunId } : {}),
            ...(artifact.metadata.attemptId ? { attemptId: artifact.metadata.attemptId } : {}),
            artifact: {
              name: artifact.metadata.name,
              revision: artifact.metadata.revision,
              sha256: artifact.metadata.sha256,
            },
          }
        : { runId: run.id };
    const projectArtifact = await latest(['prd', 'scaffold-manifest']);
    const planArtifact = await latest(['plan.current']);
    const implementationArtifact = await latest(['implementation.report']);
    const verificationArtifact = await latest(['verification.report']);
    const browserArtifact = await latest(['browser-verification.report']);
    const databaseArtifact = await latest(['database.evidence']);
    const failureClass = preflight ? automaticFailureClass(run, attempts) : 'environment';
    const approvedVerification = async (
      artifact: Awaited<ReturnType<typeof latest>>,
      name: string,
    ) => {
      const report = artifact ? VerificationReportSchema.safeParse(artifact.content) : null;
      const approved =
        name === 'browser-verification.report'
          ? await this.isApprovedBrowserEvidence(run, artifact)
          : report?.success === true && report.data.approved;
      if (!artifact || !approved) return false;
      const reference = storedArtifactReference(artifact);
      return (
        hasArtifactCreatedEvent(runEvents, reference) &&
        hasApprovedVerificationEvent(runEvents, reference, name)
      );
    };
    const planReference = planArtifact ? storedArtifactReference(planArtifact) : undefined;
    const hasApprovedPlan = Boolean(
      planReference &&
      runEvents.some(
        (event) =>
          event.type === 'run.approval_decided' &&
          event.data.action === 'approve' &&
          sameArtifactReference(planReference, event.data.reviewedArtifact),
      ),
    );
    const gate = (
      id: ValidationEvidencePublicationRequest['gates'][number]['id'],
      artifact: Awaited<ReturnType<typeof latest>>,
      passed: boolean,
      summary: string,
    ) => ({
      id,
      status: passed ? ('passed' as const) : ('unavailable' as const),
      ...(passed ? {} : { failureClass, summary }),
      references: [reference(artifact)],
    });
    return {
      environmentReadiness,
      gates: [
        gate(
          'project-created',
          projectArtifact,
          runEvents.some((event) => event.type === 'project.created') && Boolean(projectArtifact),
          'Project creation evidence was not persisted.',
        ),
        gate(
          'plan-approved',
          planArtifact,
          hasApprovedPlan,
          'Approved plan evidence was not persisted.',
        ),
        gate(
          'implementation-generated',
          implementationArtifact,
          Boolean(
            implementationArtifact &&
            hasArtifactCreatedEvent(runEvents, storedArtifactReference(implementationArtifact)),
          ),
          'Implementation output evidence was not persisted.',
        ),
        gate(
          'deterministic-checks',
          verificationArtifact,
          await approvedVerification(verificationArtifact, 'verification.report'),
          'A passing deterministic verification was not persisted.',
        ),
        gate(
          'preview-healthy',
          browserArtifact,
          runEvents.some((event) => event.type === 'project.provisioned') &&
            (await approvedVerification(browserArtifact, 'browser-verification.report')),
          'Preview health evidence was not persisted.',
        ),
        gate(
          'browser-acceptance',
          browserArtifact,
          await approvedVerification(browserArtifact, 'browser-verification.report'),
          'Passing browser evidence was not persisted.',
        ),
        gate(
          'database-match',
          databaseArtifact,
          await (async () => {
            const browserRef = databaseEvidenceBrowserRef(
              databaseArtifact,
              verificationArtifact ? storedArtifactReference(verificationArtifact) : undefined,
              verificationArtifact,
            );
            return Boolean(
              browserRef && (await this.isPersistedApprovedBrowserReport(run, browserRef)),
            );
          })(),
          'Database match evidence was not persisted.',
        ),
        gate(
          'terminal-run',
          null,
          run.status === 'completed' && Boolean(run.completedAt),
          'Terminal run evidence was not persisted.',
        ),
      ],
    };
  }

  private async validateArtifactReference(
    run: WorkflowRun,
    reference: ValidationEvidenceReference,
    allowUpstreamLineage = false,
  ): Promise<void> {
    const artifactReference = reference.artifact;
    if (!artifactReference) return;
    const artifact = await this.artifacts.getRevision(
      run.projectId,
      artifactReference.name,
      artifactReference.revision,
    );
    if (
      !artifact ||
      artifact.metadata.sha256 !== artifactReference.sha256 ||
      (artifact.metadata.runId !== undefined && artifact.metadata.runId !== run.id) ||
      (!allowUpstreamLineage &&
        ((artifact.metadata.stepRunId !== undefined &&
          artifact.metadata.stepRunId !== reference.stepRunId) ||
          (artifact.metadata.attemptId !== undefined &&
            artifact.metadata.attemptId !== reference.attemptId))) ||
      (reference.stepRunId !== undefined && artifact.metadata.stepRunId !== reference.stepRunId) ||
      (reference.attemptId !== undefined && artifact.metadata.attemptId !== reference.attemptId)
    ) {
      throw new ValidationError(
        `Evidence artifact ${artifactReference.name}@${artifactReference.revision} does not match run ${run.id}`,
      );
    }
  }

  private async hasOperatorAcceptance(
    run: WorkflowRun,
    input: ValidationEvidencePublicationRequest,
  ): Promise<boolean> {
    const firstArtifactReference = (gateId: ValidationEvidenceGateId) =>
      input.gates
        .find((gate) => gate.id === gateId)
        ?.references.find((reference) => reference.artifact)?.artifact;
    const browserArtifact = firstArtifactReference('browser-acceptance');
    const databaseArtifact = firstArtifactReference('database-match');
    if (!browserArtifact || !databaseArtifact) return false;
    const events = await this.events.list(run.projectId);
    return events.some(
      (event) =>
        event.runId === run.id &&
        event.type === 'validation.operator_accepted' &&
        sameArtifactReference(browserArtifact, event.data.browserArtifact) &&
        sameArtifactReference(databaseArtifact, event.data.databaseArtifact),
    );
  }

  /** The database evidence may pin any approved browser report persisted by
   * this run — the report whose journey created the matched row — not
   * necessarily the revision the browser-acceptance gate proves (#398). */
  private async isPersistedApprovedBrowserReport(
    run: WorkflowRun,
    reference: ArtifactReference,
  ): Promise<boolean> {
    if (reference.name !== 'browser-verification.report') return false;
    const artifact = await this.artifacts.getRevision(
      run.projectId,
      reference.name,
      reference.revision,
    );
    if (
      !artifact ||
      artifact.metadata.sha256 !== reference.sha256 ||
      artifact.metadata.runId !== run.id
    ) {
      return false;
    }
    const report = BrowserVerificationReportSchema.safeParse(artifact.content);
    return Boolean(report.success && report.data.approved);
  }

  private async isApprovedBrowserEvidence(
    run: WorkflowRun,
    artifact: StoredArtifact | null,
  ): Promise<boolean> {
    if (
      !artifact ||
      artifact.metadata.runId !== run.id ||
      !artifact.metadata.stepRunId ||
      !artifact.metadata.attemptId
    ) {
      return false;
    }
    const sourceAttempt = await this.stepAttempts.get(
      run.id,
      artifact.metadata.stepRunId,
      artifact.metadata.attemptId,
    );
    if (
      !sourceAttempt ||
      sourceAttempt.status !== 'succeeded' ||
      !sourceAttempt.outputArtifacts.some((reference) =>
        sameArtifactReference(storedArtifactReference(artifact), reference),
      )
    ) {
      return false;
    }
    const planReference = sourceAttempt.inputArtifacts.find(
      (reference) => reference.name === 'browser-test.plan',
    );
    if (!planReference || !sourceAttempt.previewSessionId) return false;
    const planArtifact = await this.artifacts.getRevision(
      run.projectId,
      planReference.name,
      planReference.revision,
    );
    const plan = planArtifact
      ? BrowserTestPlanArtifactSchema.safeParse(planArtifact.content)
      : null;
    const report = BrowserVerificationReportSchema.safeParse(artifact.content);
    // Approved may carry advisory failed steps (#441/#451); the schema already
    // forbids passive failure evidence in an approved report, and the CRUD
    // journey check below requires the value-bearing steps to have passed.
    if (!plan?.success || !report.success || !report.data.approved) return false;
    try {
      const bound = validateBrowserVerificationReportBinding(report.data, {
        planArtifact: planReference,
        planContent: planArtifact?.content,
        previewSessionId: sourceAttempt.previewSessionId,
      });
      return hasValidationCrudJourney(plan.data.data, bound);
    } catch {
      return false;
    }
  }
}

function hasValidationCrudJourney(
  plan: BrowserTestPlan,
  report: BrowserVerificationReport,
): boolean {
  const fillIndex = plan.steps.findIndex((step) => step.action.kind === 'fill');
  if (fillIndex < 0) return false;
  const fillStep = plan.steps[fillIndex];
  if (!fillStep || fillStep.action.kind !== 'fill') return false;
  const expectedValue = fillStep.action.value;
  const hasExpectedValue = (step: BrowserTestPlan['steps'][number]): boolean =>
    step.assertions.some(
      (assertion) => assertion.kind === 'containsText' && assertion.expected === expectedValue,
    );
  const createIndex = plan.steps.findIndex(
    (step, index) => index > fillIndex && step.action.kind === 'click' && hasExpectedValue(step),
  );
  if (createIndex < 0) return false;
  // One post-create goto asserting the created value is the reload proof
  // OPERATIONS.md defines ("visibly creates and reloads"); planners may or may
  // not add a separate list step before it (#453).
  const reloadSteps = plan.steps.filter(
    (step, index) => index > createIndex && step.action.kind === 'goto' && hasExpectedValue(step),
  );
  if (reloadSteps.length < 1) return false;
  // The value-bearing journey must have actually passed — advisory failures
  // are tolerated only on steps outside it (#441).
  const passedStepIds = new Set(
    report.steps.filter((step) => step.status === 'passed').map((step) => step.stepId),
  );
  const journeySteps = [fillStep, plan.steps[createIndex]!, ...reloadSteps];
  return journeySteps.every((step) => passedStepIds.has(step.id));
}

export function buildValidationEvidenceBundle(options: {
  run: WorkflowRun;
  campaignId: ValidationEvidenceBundle['campaignId'];
  sourceRevision: string;
  input: ValidationEvidencePublicationRequest;
  attempts: readonly StepAttempt[];
  publishedAt: string;
  trustedPreflight?: ValidationPreflightReport;
  automaticCapture?: boolean;
  operatorAccepted?: boolean;
}): ValidationEvidenceBundle {
  const publication = options.input;
  const gates = publication.gates.map((gate) => ({
    ...gate,
    ...(gate.summary ? { summary: redactModelText(gate.summary) } : {}),
  }));
  const attempts = options.attempts.map(toEvidenceAttempt);
  const usage = summarizeValidationUsage(options.attempts);
  const terminalState = toTerminalState(options.run);
  const skippedGates = gates
    .filter((gate) => gate.status === 'skipped' || gate.status === 'unavailable')
    .map((gate) => gate.id);
  const outcome = classifyOutcome(
    options.run,
    publication,
    options.attempts.length,
    automaticFailureClass(options.run, options.attempts),
    options.trustedPreflight,
    options.automaticCapture,
    options.operatorAccepted,
  );
  const browserEvidence = gates.find((gate) => gate.id === 'browser-acceptance')?.references ?? [];
  const databaseEvidence = gates.find((gate) => gate.id === 'database-match')?.references ?? [];
  const environmentReadiness = options.trustedPreflight
    ? {
        status: options.trustedPreflight.status,
        environmentId: options.trustedPreflight.environmentId,
        checks: options.trustedPreflight.checks.map((check) => ({
          boundary: check.boundary,
          status: check.status,
          durationMs: check.durationMs,
          ...(check.message ? { message: check.message } : {}),
          ...(check.errorCode ? { errorCode: check.errorCode } : {}),
          ...(check.provider ? { provider: check.provider } : {}),
          ...(check.selectedModel ? { selectedModel: check.selectedModel } : {}),
          ...(check.executedModel ? { executedModel: check.executedModel } : {}),
        })),
      }
    : {
        status: 'environment-blocked' as const,
        environmentId: `validation-run-${options.run.id}`,
        checks: [
          {
            boundary: 'source-revision' as const,
            status: 'failed' as const,
            durationMs: 0,
            message: 'No trusted validation preflight report was available for this run.',
            errorCode: 'PREFLIGHT_NOT_RUN',
          },
        ],
      };

  return ValidationEvidenceBundleSchema.parse(
    redactUnknown({
      schemaVersion: '1',
      campaignId: options.campaignId,
      sourceRevision: options.sourceRevision,
      projectId: options.run.projectId,
      runId: options.run.id,
      environmentReadiness: {
        ...environmentReadiness,
        checks: environmentReadiness.checks.map((check) => ({
          ...check,
          ...(check.message ? { message: redactOpsText(check.message) } : {}),
          // Model fields carry provider-shaped text, so they keep the stricter
          // rule the attempt-level ones use.
          ...(check.selectedModel
            ? { selectedModel: redactModelText(check.selectedModel, 200) }
            : {}),
          ...(check.executedModel
            ? { executedModel: redactModelText(check.executedModel, 200) }
            : {}),
        })),
      },
      gates,
      attempts,
      usage: {
        attemptsByStep: usage.attemptsByStep,
        subscriptionQuotaUnits: usage.subscriptionQuotaUnits,
        subscriptionQuotaUnitsByProvider: usage.subscriptionQuotaUnitsByProvider,
      },
      checkpoints: attempts.flatMap((attempt) =>
        attempt.checkpoint
          ? [{ reference: attempt.reference, checkpoint: attempt.checkpoint }]
          : [],
      ),
      deterministicResults: gates.filter((gate) =>
        ['implementation-generated', 'deterministic-checks'].includes(gate.id),
      ),
      browserEvidence,
      databaseEvidence,
      terminalState,
      skippedGates,
      outcome,
      publishedAt: options.publishedAt,
    }),
  );
}

function toEvidenceAttempt(attempt: StepAttempt): ValidationEvidenceAttempt {
  return {
    reference: {
      runId: attempt.runId,
      stepRunId: attempt.stepRunId,
      attemptId: attempt.id,
    },
    provider: attempt.provider,
    ...(attempt.modelId ? { modelId: attempt.modelId } : {}),
    selectedModel: redactModelText(
      attempt.routeDecision?.selected.model.model ?? attempt.model,
      200,
    ),
    executedModel: redactModelText(attempt.executedModel ?? attempt.model, 200),
    status: attempt.status,
    ...(attempt.durationMs !== undefined ? { durationMs: attempt.durationMs } : {}),
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.checkpoint ? { checkpoint: redactModelText(attempt.checkpoint, 200) } : {}),
    outputArtifacts: attempt.outputArtifacts,
  };
}

function toTerminalState(run: WorkflowRun): ValidationEvidenceTerminalState {
  return {
    status: run.status,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error
      ? {
          error: {
            name: redactModelText(run.error.name, 200),
            message: redactModelText(run.error.message, 1_000),
            ...(run.error.code ? { code: redactModelText(run.error.code, 200) } : {}),
            ...(run.error.exitCode !== undefined ? { exitCode: run.error.exitCode } : {}),
          },
        }
      : {}),
  };
}

/**
 * Instruction words are ordinary English in an ops diagnostic — "scaffold build
 * failed", "cannot create container" — so they only mark free-form model text,
 * never a gate message. Role markers and addresses mark a prompt wherever they
 * appear.
 */
const INSTRUCTION_LIKE =
  /\b(?:you are|write|implement|inspect|produce|respond with|acceptance criteria|create|build|make|add|delete|update|list|show|please|the user|application|todo|app)\b/i;
const PROMPT_SHAPED = /(?:^|\b)(?:system|user|assistant)\s*:/i;

function redactModelText(value: string, maxLength = 500): string {
  if (INSTRUCTION_LIKE.test(value)) return '[REDACTED_PROMPT]';
  return redactOpsText(value, maxLength);
}

/**
 * Preflight boundaries report why a gate failed. Redacting them by prompt
 * keywords published `[REDACTED_PROMPT]` for every real failure — evidence that
 * is empty, not redacted, at the one boundary #397 attaches evidence from.
 * Secrets, addresses, personal paths and database values still go.
 */
function redactOpsText(value: string, maxLength = 500): string {
  if (PROMPT_SHAPED.test(value) || containsEmailLike(value)) {
    return '[REDACTED_PROMPT]';
  }
  const isDatabaseLike =
    /(?:select|insert|update|delete)\b[\s\S]*(?:password|secret|token|email)/i.test(value) ||
    /\b(?:database|db|sql|row|record|table|column|email|password|secret|token|user_id)\b/i.test(
      value,
    );
  if (isDatabaseLike) {
    return '[REDACTED_DATABASE_VALUE]';
  }
  return redactPersonalPaths(redactString(value)).slice(0, maxLength);
}

function containsEmailLike(value: string): boolean {
  for (
    let atIndex = value.indexOf('@');
    atIndex !== -1;
    atIndex = value.indexOf('@', atIndex + 1)
  ) {
    let localStart = atIndex - 1;
    while (localStart >= 0 && isEmailLocalChar(value.charCodeAt(localStart))) {
      localStart -= 1;
    }
    if (localStart === atIndex - 1) continue;

    let cursor = atIndex + 1;
    let labelLength = 0;
    let hasDot = false;
    while (cursor < value.length) {
      const code = value.charCodeAt(cursor);
      if (isEmailDomainChar(code)) {
        labelLength += 1;
        cursor += 1;
        continue;
      }
      if (code === 46 && labelLength > 0 && cursor + 1 < value.length) {
        const nextCode = value.charCodeAt(cursor + 1);
        if (!isEmailDomainChar(nextCode)) {
          break;
        }
        hasDot = true;
        labelLength = 0;
        cursor += 1;
        continue;
      }
      break;
    }
    if (hasDot && labelLength > 0) return true;
  }
  return false;
}

function isEmailLocalChar(code: number): boolean {
  return isAsciiLetterOrDigit(code) || code === 43 || code === 45 || code === 46 || code === 95;
}

function isEmailDomainChar(code: number): boolean {
  return isAsciiLetterOrDigit(code) || code === 45 || code === 95;
}

function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function storedArtifactReference(artifact: StoredArtifact) {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function sameArtifactReference(reference: ArtifactReference, candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Record<string, unknown>;
  return (
    value.name === reference.name &&
    value.revision === reference.revision &&
    value.sha256 === reference.sha256
  );
}

function hasArtifactCreatedEvent(
  events: readonly ProjectEvent[],
  reference: ArtifactReference,
): boolean {
  return events.some(
    (event) => event.type === 'artifact.created' && sameArtifactReference(reference, event.data),
  );
}

function hasApprovedVerificationEvent(
  events: readonly ProjectEvent[],
  reference: ArtifactReference,
  artifactName: string,
): boolean {
  return events.some(
    (event) =>
      event.type === 'verification.completed' &&
      event.data.approved === true &&
      event.data.artifactName === artifactName &&
      sameArtifactReference(reference, event.data.artifact),
  );
}

/** The browser report the database evidence pins, or null when the evidence
 * itself is invalid. The caller validates that report separately: it may be an
 * earlier revision than the one the browser-acceptance gate proves — a
 * per-task assert and the standalone verification both persist reports, and
 * the row-match binds to whichever created the matched row (#398). */
function databaseEvidenceBrowserRef(
  artifact: StoredArtifact | null,
  verificationArtifact: ArtifactReference | undefined,
  verificationReportArtifact: StoredArtifact | null,
): ArtifactReference | null {
  if (
    !artifact ||
    artifact.metadata.name !== 'database.evidence' ||
    !artifact.metadata.runId ||
    !artifact.metadata.stepRunId ||
    !artifact.metadata.attemptId ||
    !verificationArtifact
  ) {
    return null;
  }
  const evidence = ValidationDatabaseEvidenceSchema.safeParse(artifact.content);
  if (
    !evidence.success ||
    !sameArtifactReference(verificationArtifact, evidence.data.verificationArtifact)
  ) {
    return null;
  }
  const report = VerificationReportSchema.safeParse(verificationReportArtifact?.content);
  const matched = Boolean(
    report.success &&
    report.data.approved &&
    report.data.commands.some(
      (command) =>
        command.name === 'database-row-match' &&
        command.exitCode === 0 &&
        !command.skipped &&
        command.stdout.includes(`AGENT_FOUNDRY_DB_MATCH:${evidence.data.rowFingerprint}`),
    ),
  );
  return matched ? evidence.data.browserArtifact : null;
}

function classifyOutcome(
  run: WorkflowRun,
  input: ValidationEvidencePublicationRequest,
  attemptCount: number,
  failureClass: ValidationEvidenceFailureClass,
  trustedPreflight?: ValidationPreflightReport,
  automaticCapture = false,
  operatorAccepted = true,
): ValidationEvidenceBundle['outcome'] {
  if (automaticCapture && !trustedPreflight) return 'environment-blocked';
  if (trustedPreflight?.status === 'environment-blocked') {
    return 'environment-blocked';
  }
  if (trustedPreflight?.status === 'model-failed') return 'model-failed';

  const failure = input.gates.find((gate) => gate.status !== 'passed');
  if (!trustedPreflight && !failure) return 'environment-blocked';
  if (failure && failureClass === 'environment') return 'environment-blocked';
  if (failure && failureClass === 'model') return 'model-failed';
  if (failure) return 'product-failed';
  if (automaticCapture && !operatorAccepted) return 'product-failed';
  if (run.status !== 'completed' || !run.completedAt || attemptCount === 0) {
    return 'product-failed';
  }
  return 'accepted';
}

function markOperatorAcceptancePending(
  input: ValidationEvidencePublicationRequest,
): ValidationEvidencePublicationRequest {
  return {
    ...input,
    gates: input.gates.map((gate) =>
      gate.id === 'browser-acceptance'
        ? {
            ...gate,
            status: 'failed' as const,
            failureClass: 'product' as const,
            summary: 'Visible operator acceptance is pending.',
          }
        : gate,
    ),
  };
}

function automaticFailureClass(
  run: WorkflowRun,
  attempts: readonly StepAttempt[],
): ValidationEvidenceFailureClass {
  const errorText = `${run.error?.name ?? ''} ${run.error?.code ?? ''}`.toLowerCase();
  if (/(?:provision|environment|docker|supabase|preview)/.test(errorText)) {
    return 'environment';
  }
  const externalAttempts = attempts.filter((attempt) => attempt.provider !== 'internal');
  if (
    /(?:provider|model|executor|cli|authentication)/.test(errorText) ||
    (externalAttempts.length > 0 &&
      externalAttempts.every((attempt) => attempt.status === 'failed'))
  ) {
    return 'model';
  }
  return 'product';
}

function evidenceArtifactName(campaignId: string): string {
  return `${EVIDENCE_ARTIFACT_PREFIX}${campaignId}`;
}

function evidenceIdempotencyKey(
  campaignId: string,
  runId: string,
  input: ValidationEvidencePublicationRequest,
): string {
  const canonicalInput = {
    environmentReadiness: {
      ...input.environmentReadiness,
      checks: [...input.environmentReadiness.checks].sort((left, right) =>
        left.boundary.localeCompare(right.boundary),
      ),
    },
    gates: [...input.gates]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((gate) => ({
        ...gate,
        references: [...gate.references].sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right)),
        ),
      })),
  };
  return createHash('sha256')
    .update(`${campaignId}:${runId}:${JSON.stringify(canonicalInput)}`)
    .digest('hex');
}
