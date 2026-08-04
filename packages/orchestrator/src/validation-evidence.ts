import { createHash } from 'node:crypto';
import {
  ValidationEvidenceBundleSchema,
  ValidationEvidencePublicationRequestSchema,
  ValidationEvidenceResponseSchema,
  VerificationReportSchema,
  type ArtifactReference,
  type ModelDefinition,
  type StepAttempt,
  type ValidationEvidenceAttempt,
  type ValidationEvidenceBundle,
  type ValidationEvidenceGateId,
  type ValidationEvidenceFailureClass,
  type ValidationEvidencePublicationRequest,
  type ValidationEvidenceReference,
  type ValidationEvidenceResponse,
  type ValidationEvidenceTerminalState,
  type ValidationPreflightReport,
  type StoredArtifact,
  type WorkflowRun,
} from '@agent-foundry/contracts';
import type {
  ArtifactStore,
  EventStore,
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import { NotFoundError, redactString, redactUnknown, ValidationError } from '@agent-foundry/domain';
import { summarizeValidationUsage } from './validation-budget.js';

const EVIDENCE_ARTIFACT_PREFIX = 'validation-evidence-';
const PERSONAL_PATH_PATTERN = /(?:\/Users|\/home)\/[^\s"'`]+/g;

export interface ValidationEvidencePublisher {
  publishFromRun(runId: string): Promise<ValidationEvidenceResponse | null>;
}

export class ValidationEvidenceService {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly catalog: readonly ModelDefinition[],
    private readonly events: EventStore,
    private readonly preflightReport?: () => Promise<ValidationPreflightReport | undefined>,
  ) {}

  async publish(
    runId: string,
    input: ValidationEvidencePublicationRequest,
  ): Promise<ValidationEvidenceResponse> {
    const run = await this.requireRun(runId);
    const parsedInput = ValidationEvidencePublicationRequestSchema.parse(input);
    const campaign = run.execution?.campaign;
    if (!campaign) {
      throw new ValidationError(`Run ${runId} is not attached to a validation campaign.`);
    }

    await this.validateReferences(run, parsedInput);
    const attempts = await this.listRunAttempts(runId);
    if (classifyOutcome(run, parsedInput, attempts.length) === 'accepted') {
      await this.validateAcceptedRuntime(run, parsedInput);
    }
    const bundle = buildValidationEvidenceBundle({
      run,
      campaignId: campaign.preview.id,
      sourceRevision: campaign.preview.sourceRevision,
      input: parsedInput,
      attempts,
      catalog: this.catalog,
      publishedAt: new Date().toISOString(),
    });
    const artifact = await this.artifacts.put({
      projectId: run.projectId,
      name: evidenceArtifactName(campaign.preview.id),
      content: bundle,
      createdBy: `validation-campaign:${campaign.preview.id}`,
      runId,
      idempotencyKey: evidenceIdempotencyKey(campaign.preview.id, runId, parsedInput),
    });
    return ValidationEvidenceResponseSchema.parse({
      bundle: ValidationEvidenceBundleSchema.parse(artifact.content),
      artifact,
    });
  }

  async publishFromRun(runId: string): Promise<ValidationEvidenceResponse | null> {
    const run = await this.requireRun(runId);
    if (!run.execution?.campaign) return null;
    return this.publish(runId, await this.capturePublication(run));
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
        if (reference.artifact) await this.validateArtifactReference(run, reference);
      }
    }
  }

  private async validateAcceptedRuntime(
    run: WorkflowRun,
    input: ValidationEvidencePublicationRequest,
  ): Promise<void> {
    const events = await this.events.list(run.projectId);
    const runEvents = events.filter((event) => event.runId === run.id);
    const gate = (id: ValidationEvidenceGateId) =>
      input.gates.find((candidate) => candidate.id === id);
    const artifactReferences = (id: ValidationEvidenceGateId) =>
      gate(id)?.references.flatMap((reference) =>
        reference.artifact ? [reference.artifact] : [],
      ) ?? [];
    const artifactNames = (id: Parameters<typeof gate>[0]) =>
      artifactReferences(id).map((reference) => reference.name);
    const hasName = (id: Parameters<typeof gate>[0], names: readonly string[]) =>
      artifactNames(id).some((name) => names.includes(name));
    const hasVerification = (id: ValidationEvidenceGateId, name: string) =>
      runEvents.some(
        (event) =>
          event.type === 'verification.completed' &&
          event.data.approved === true &&
          event.data.artifactName === name &&
          artifactReferences(id).some((reference) =>
            sameArtifactReference(reference, event.data.artifact),
          ),
      );
    const hasDatabaseProof = async () => {
      for (const reference of artifactReferences('database-match')) {
        const artifact = await this.artifacts.getRevision(
          run.projectId,
          reference.name,
          reference.revision,
        );
        if (artifact && isDatabaseEvidence(artifact)) return true;
      }
      return false;
    };
    const missing: string[] = [];
    if (
      !events.some((event) => event.type === 'project.created') ||
      !hasName('project-created', ['prd', 'scaffold-manifest'])
    ) {
      missing.push('project-created');
    }
    if (
      !runEvents.some(
        (event) => event.type === 'run.approval_decided' && event.data.action === 'approve',
      ) ||
      !hasName('plan-approved', ['plan.current'])
    ) {
      missing.push('plan-approved');
    }
    if (!hasName('implementation-generated', ['implementation.report'])) {
      missing.push('implementation-generated');
    }
    if (
      !hasName('deterministic-checks', ['verification.report']) ||
      !hasVerification('deterministic-checks', 'verification.report')
    ) {
      missing.push('deterministic-checks');
    }
    if (
      !runEvents.some((event) => event.type === 'project.provisioned') ||
      !hasName('preview-healthy', ['browser-verification.report'])
    ) {
      missing.push('preview-healthy');
    }
    if (
      !hasName('browser-acceptance', ['browser-verification.report']) ||
      !hasVerification('browser-acceptance', 'browser-verification.report')
    ) {
      missing.push('browser-acceptance');
    }
    if (!(await hasDatabaseProof())) {
      missing.push('database-match');
    }
    if (run.status !== 'completed' || !run.completedAt) missing.push('terminal-run');
    if (missing.length > 0) {
      throw new ValidationError(
        `Accepted evidence is not proven by persisted runtime evidence: ${missing.join(', ')}`,
      );
    }
  }

  private async capturePublication(
    run: WorkflowRun,
  ): Promise<ValidationEvidencePublicationRequest> {
    const candidatePreflight = await this.preflightReport?.();
    const preflight =
      candidatePreflight &&
      candidatePreflight.campaignId === run.execution?.campaign?.preview.id &&
      candidatePreflight.sourceRevision === run.execution?.campaign?.preview.sourceRevision
        ? candidatePreflight
        : undefined;
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
    const latest = async (names: readonly string[], runBound = true) => {
      const metadata = (await this.artifacts.listMetadata(run.projectId))
        .filter((item) => names.includes(item.name) && (!runBound || item.runId === run.id))
        .at(-1);
      return metadata
        ? this.artifacts.getRevision(run.projectId, metadata.name, metadata.revision)
        : null;
    };
    const reference = (artifact: Awaited<ReturnType<typeof latest>>) =>
      artifact
        ? {
            runId: run.id,
            artifact: {
              name: artifact.metadata.name,
              revision: artifact.metadata.revision,
              sha256: artifact.metadata.sha256,
            },
          }
        : { runId: run.id };
    const projectArtifact = await latest(['prd', 'scaffold-manifest'], false);
    const planArtifact = await latest(['plan.current']);
    const implementationArtifact = await latest(['implementation.report']);
    const verificationArtifact = await latest(['verification.report']);
    const browserArtifact = await latest(['browser-verification.report']);
    const databaseArtifact = await latest(['database.evidence', 'db.evidence']);
    const failureClass = automaticFailureClass(run);
    const approvedVerification = (artifact: Awaited<ReturnType<typeof latest>>, name: string) =>
      Boolean(
        artifact &&
        runEvents.some(
          (event) =>
            event.type === 'verification.completed' &&
            event.data.approved === true &&
            event.data.artifactName === name &&
            sameArtifactReference(storedArtifactReference(artifact), event.data.artifact),
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
          events.some((event) => event.type === 'project.created') && Boolean(projectArtifact),
          'Project creation evidence was not persisted.',
        ),
        gate(
          'plan-approved',
          planArtifact,
          runEvents.some(
            (event) => event.type === 'run.approval_decided' && event.data.action === 'approve',
          ) && Boolean(planArtifact),
          'Approved plan evidence was not persisted.',
        ),
        gate(
          'implementation-generated',
          implementationArtifact,
          Boolean(implementationArtifact),
          'Implementation output evidence was not persisted.',
        ),
        gate(
          'deterministic-checks',
          verificationArtifact,
          Boolean(verificationArtifact) &&
            approvedVerification(verificationArtifact, 'verification.report'),
          'A passing deterministic verification was not persisted.',
        ),
        gate(
          'preview-healthy',
          browserArtifact,
          runEvents.some((event) => event.type === 'project.provisioned') &&
            Boolean(browserArtifact),
          'Preview health evidence was not persisted.',
        ),
        gate(
          'browser-acceptance',
          browserArtifact,
          Boolean(browserArtifact) &&
            approvedVerification(browserArtifact, 'browser-verification.report'),
          'Passing browser evidence was not persisted.',
        ),
        gate(
          'database-match',
          isDatabaseEvidence(verificationArtifact) ? verificationArtifact : databaseArtifact,
          isDatabaseEvidence(verificationArtifact) || isDatabaseEvidence(databaseArtifact),
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
      (artifact.metadata.runId !== undefined && artifact.metadata.runId !== run.id)
    ) {
      throw new ValidationError(
        `Evidence artifact ${artifactReference.name}@${artifactReference.revision} does not match run ${run.id}`,
      );
    }
  }
}

export function buildValidationEvidenceBundle(options: {
  run: WorkflowRun;
  campaignId: ValidationEvidenceBundle['campaignId'];
  sourceRevision: string;
  input: ValidationEvidencePublicationRequest;
  attempts: readonly StepAttempt[];
  catalog: readonly ModelDefinition[];
  publishedAt: string;
}): ValidationEvidenceBundle {
  const publication = options.input;
  const gates = publication.gates.map((gate) => ({
    ...gate,
    ...(gate.summary ? { summary: redactEvidenceText(gate.summary) } : {}),
  }));
  const attempts = options.attempts.map(toEvidenceAttempt);
  const usage = summarizeValidationUsage(options.attempts, options.catalog);
  const terminalState = toTerminalState(options.run);
  const skippedGates = gates.filter((gate) => gate.status === 'skipped').map((gate) => gate.id);
  const outcome = classifyOutcome(options.run, publication, options.attempts.length);
  const browserEvidence = gates.find((gate) => gate.id === 'browser-acceptance')?.references ?? [];
  const databaseEvidence = gates.find((gate) => gate.id === 'database-match')?.references ?? [];

  return ValidationEvidenceBundleSchema.parse(
    redactUnknown({
      schemaVersion: '1',
      campaignId: options.campaignId,
      sourceRevision: options.sourceRevision,
      projectId: options.run.projectId,
      runId: options.run.id,
      environmentReadiness: {
        ...publication.environmentReadiness,
        checks: publication.environmentReadiness.checks.map((check) => ({
          ...check,
          ...(check.message ? { message: redactEvidenceText(check.message) } : {}),
          ...(check.selectedModel
            ? { selectedModel: redactEvidenceText(check.selectedModel, 200) }
            : {}),
          ...(check.executedModel
            ? { executedModel: redactEvidenceText(check.executedModel, 200) }
            : {}),
        })),
      },
      gates,
      attempts,
      usage: {
        attemptsByStep: usage.attemptsByStep,
        providerReportedCostUsd: usage.providerReportedCostUsd,
        catalogEstimatedCostUsd: usage.catalogEstimatedCostUsd,
        meteredCostUsd: usage.unknownMeteredAttempts > 0 ? null : usage.meteredCostUsd,
        unknownMeteredAttempts: usage.unknownMeteredAttempts,
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
    selectedModel: redactEvidenceText(
      attempt.routeDecision?.selected.model.model ?? attempt.model,
      200,
    ),
    executedModel: redactEvidenceText(attempt.executedModel ?? attempt.model, 200),
    status: attempt.status,
    ...(attempt.durationMs !== undefined ? { durationMs: attempt.durationMs } : {}),
    ...(attempt.usage ? { usage: attempt.usage } : {}),
    ...(attempt.checkpoint ? { checkpoint: attempt.checkpoint } : {}),
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
            name: redactEvidenceText(run.error.name, 200),
            message: redactEvidenceText(run.error.message, 1_000),
            ...(run.error.code ? { code: run.error.code } : {}),
            ...(run.error.exitCode !== undefined ? { exitCode: run.error.exitCode } : {}),
          },
        }
      : {}),
  };
}

function redactEvidenceText(value: string, maxLength = 500): string {
  if (/(?:^|\b)(?:system|user|assistant)\s*:/i.test(value)) return '[REDACTED_PROMPT]';
  if (/(?:select|insert|update|delete)\b[\s\S]*(?:password|secret|token|email)/i.test(value)) {
    return '[REDACTED_DATABASE_VALUE]';
  }
  return redactString(value).replace(PERSONAL_PATH_PATTERN, '[REDACTED]').slice(0, maxLength);
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

function isDatabaseEvidence(artifact: StoredArtifact | null): boolean {
  if (!artifact) return false;
  if (artifact.metadata.name === 'database.evidence' || artifact.metadata.name === 'db.evidence') {
    const content = artifact.content;
    return (
      typeof content === 'object' &&
      content !== null &&
      ((content as Record<string, unknown>).status === 'matched' ||
        (content as Record<string, unknown>).databaseMatch === true)
    );
  }
  const report = VerificationReportSchema.safeParse(artifact.content);
  return (
    report.success &&
    report.data.approved &&
    report.data.commands.some(
      (command) =>
        /^(?:smoke|db:start|db:reset)$/i.test(command.name) &&
        command.exitCode === 0 &&
        !command.skipped,
    )
  );
}

function classifyOutcome(
  run: WorkflowRun,
  input: ValidationEvidencePublicationRequest,
  attemptCount: number,
): ValidationEvidenceBundle['outcome'] {
  if (input.environmentReadiness.status === 'environment-blocked') {
    return 'environment-blocked';
  }
  if (input.environmentReadiness.status === 'model-failed') return 'model-failed';

  const failure = input.gates.find((gate) => gate.status !== 'passed');
  if (failure?.failureClass === 'environment') return 'environment-blocked';
  if (failure?.failureClass === 'model') return 'model-failed';
  if (failure?.status === 'unavailable') return 'product-failed';
  if (failure) return 'product-failed';
  if (run.status !== 'completed' || !run.completedAt || attemptCount === 0) {
    return 'product-failed';
  }
  return 'accepted';
}

function automaticFailureClass(run: WorkflowRun): ValidationEvidenceFailureClass {
  const code = run.error?.code?.toLowerCase() ?? '';
  if (/(?:provision|environment|docker|supabase|preview)/.test(code)) return 'environment';
  if (/(?:provider|model|executor|cli)/.test(code)) return 'model';
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
  return createHash('sha256')
    .update(`${campaignId}:${runId}:${JSON.stringify(input)}`)
    .digest('hex');
}
