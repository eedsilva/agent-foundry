import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';
import {
  ArtifactReferenceSchema,
  ExecutionUsageSchema,
  StepAttemptStatusSchema,
  WorkflowRunStatusSchema,
} from './run.js';
import { ValidationCampaignIdSchema } from './validation-campaign.js';
import { ValidationPreflightBoundarySchema } from './validation-preflight.js';
import { StoredArtifactSchema } from './project.js';

export const ValidationEvidenceOutcomeSchema = z.enum([
  'accepted',
  'product-failed',
  'model-failed',
  'environment-blocked',
]);
export type ValidationEvidenceOutcome = z.infer<typeof ValidationEvidenceOutcomeSchema>;

export const ValidationEvidenceGateIdSchema = z.enum([
  'project-created',
  'plan-approved',
  'implementation-generated',
  'deterministic-checks',
  'preview-healthy',
  'browser-acceptance',
  'database-match',
  'terminal-run',
]);
export type ValidationEvidenceGateId = z.infer<typeof ValidationEvidenceGateIdSchema>;

export const VALIDATION_EVIDENCE_GATE_IDS: readonly ValidationEvidenceGateId[] = [
  'project-created',
  'plan-approved',
  'implementation-generated',
  'deterministic-checks',
  'preview-healthy',
  'browser-acceptance',
  'database-match',
  'terminal-run',
];

const MAX_EVIDENCE_REFERENCES = 20;
const MAX_EVIDENCE_CHECKS = 32;
const MAX_EVIDENCE_ATTEMPTS = 256;
const MAX_EVIDENCE_ARTIFACTS = 64;

export const ValidationEvidenceGateStatusSchema = z.enum([
  'passed',
  'failed',
  'skipped',
  'unavailable',
]);
export type ValidationEvidenceGateStatus = z.infer<typeof ValidationEvidenceGateStatusSchema>;

export const ValidationEvidenceFailureClassSchema = z.enum(['product', 'model', 'environment']);
export type ValidationEvidenceFailureClass = z.infer<typeof ValidationEvidenceFailureClassSchema>;

export const ValidationDatabaseEvidenceSchema = z
  .object({
    schemaVersion: z.literal('1'),
    status: z.literal('matched'),
    verification: z.literal('create-list-reload'),
    rowFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    browserArtifact: ArtifactReferenceSchema,
    verificationArtifact: ArtifactReferenceSchema,
    checkedAt: z.string().datetime(),
  })
  .strict();
export type ValidationDatabaseEvidence = z.infer<typeof ValidationDatabaseEvidenceSchema>;

export const ValidationEvidenceReferenceSchema = z
  .object({
    runId: PathSegmentSchema,
    stepRunId: PathSegmentSchema.optional(),
    attemptId: PathSegmentSchema.optional(),
    artifact: ArtifactReferenceSchema.optional(),
  })
  .strict();
export type ValidationEvidenceReference = z.infer<typeof ValidationEvidenceReferenceSchema>;

export const ValidationEvidenceGateSchema = z
  .object({
    id: ValidationEvidenceGateIdSchema,
    status: ValidationEvidenceGateStatusSchema,
    failureClass: ValidationEvidenceFailureClassSchema.optional(),
    summary: z.string().trim().max(500).optional(),
    references: z.array(ValidationEvidenceReferenceSchema).max(MAX_EVIDENCE_REFERENCES),
  })
  .strict()
  .superRefine((gate, context) => {
    if (gate.status === 'passed' && gate.references.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['references'],
        message: 'A passed gate requires at least one immutable evidence reference',
      });
    }
    if (gate.status !== 'passed' && !gate.failureClass) {
      context.addIssue({
        code: 'custom',
        path: ['failureClass'],
        message: 'A non-passed gate requires a failure classification',
      });
    }
  });
export type ValidationEvidenceGate = z.infer<typeof ValidationEvidenceGateSchema>;

export const ValidationEvidenceCheckSchema = z
  .object({
    boundary: ValidationPreflightBoundarySchema,
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().int().nonnegative(),
    message: z.string().trim().max(500).optional(),
    errorCode: PathSegmentSchema.optional(),
    provider: ProviderSchema.optional(),
    selectedModel: z.string().trim().min(1).max(200).optional(),
    executedModel: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ValidationEvidenceCheck = z.infer<typeof ValidationEvidenceCheckSchema>;

export const ValidationEnvironmentReadinessSchema = z
  .object({
    status: z.enum(['passed', 'environment-blocked', 'model-failed']),
    environmentId: PathSegmentSchema,
    checks: z.array(ValidationEvidenceCheckSchema).min(1).max(MAX_EVIDENCE_CHECKS),
  })
  .strict()
  .superRefine((readiness, context) => {
    const hasFailure = readiness.checks.some((check) => check.status === 'failed');
    if (readiness.status === 'passed' && hasFailure) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Passed environment readiness cannot contain a failed check',
      });
    }
    if (readiness.status !== 'passed' && !hasFailure) {
      context.addIssue({
        code: 'custom',
        path: ['checks'],
        message: 'Blocked readiness requires a failed check',
      });
    }
  });
export type ValidationEnvironmentReadiness = z.infer<typeof ValidationEnvironmentReadinessSchema>;

export const ValidationEvidencePublicationRequestSchema = z
  .object({
    environmentReadiness: ValidationEnvironmentReadinessSchema,
    gates: z
      .array(ValidationEvidenceGateSchema)
      .min(VALIDATION_EVIDENCE_GATE_IDS.length)
      .max(VALIDATION_EVIDENCE_GATE_IDS.length),
  })
  .strict()
  .superRefine((input, context) => {
    const counts = new Map<ValidationEvidenceGateId, number>();
    for (const gate of input.gates) counts.set(gate.id, (counts.get(gate.id) ?? 0) + 1);
    for (const id of VALIDATION_EVIDENCE_GATE_IDS) {
      if (counts.get(id) !== 1) {
        context.addIssue({
          code: 'custom',
          path: ['gates'],
          message: `Expected exactly one observation for ${id}`,
        });
      }
    }
    if (input.gates.length !== VALIDATION_EVIDENCE_GATE_IDS.length) {
      context.addIssue({
        code: 'custom',
        path: ['gates'],
        message: 'Expected exactly one observation for every mandatory gate',
      });
    }
  });
export type ValidationEvidencePublicationRequest = z.infer<
  typeof ValidationEvidencePublicationRequestSchema
>;

export const ValidationOperatorAcceptanceRequestSchema = z
  .object({
    decidedBy: z.string().trim().min(1).max(200),
    browserArtifact: ArtifactReferenceSchema,
    databaseArtifact: ArtifactReferenceSchema,
  })
  .strict();
export type ValidationOperatorAcceptanceRequest = z.infer<
  typeof ValidationOperatorAcceptanceRequestSchema
>;

export const ValidationEvidenceAttemptSchema = z
  .object({
    reference: ValidationEvidenceReferenceSchema,
    provider: ProviderSchema.or(z.literal('internal')),
    modelId: PathSegmentSchema.optional(),
    selectedModel: z.string().trim().min(1).max(200).optional(),
    executedModel: z.string().trim().min(1).max(200).optional(),
    status: StepAttemptStatusSchema,
    durationMs: z.number().nonnegative().optional(),
    usage: ExecutionUsageSchema.optional(),
    checkpoint: z.string().trim().min(1).max(200).optional(),
    outputArtifacts: z.array(ArtifactReferenceSchema).max(MAX_EVIDENCE_ARTIFACTS),
  })
  .strict();
export type ValidationEvidenceAttempt = z.infer<typeof ValidationEvidenceAttemptSchema>;

export const ValidationEvidenceUsageSchema = z
  .object({
    attemptsByStep: z
      .record(z.string(), z.number().int().nonnegative())
      .refine((value) => Object.keys(value).length <= MAX_EVIDENCE_ATTEMPTS),
    // Legacy cost cross-checks (#439): only the retired validation campaign
    // read these. Kept optional so bundles published before the dismantling
    // still parse; new bundles omit them. Per-attempt usage remains the
    // cost evidence.
    providerReportedCostUsd: z.number().nonnegative().nullable().optional(),
    catalogEstimatedCostUsd: z.number().nonnegative().nullable().optional(),
    meteredCostUsd: z.number().nonnegative().nullable().optional(),
    unknownMeteredAttempts: z.number().int().nonnegative().optional(),
    subscriptionQuotaUnits: z.number().nonnegative(),
    subscriptionQuotaUnitsByProvider: z
      .record(z.string(), z.number().nonnegative())
      .refine((value) => Object.keys(value).length <= MAX_EVIDENCE_CHECKS),
  })
  .strict();
export type ValidationEvidenceUsage = z.infer<typeof ValidationEvidenceUsageSchema>;

const ValidationEvidenceErrorSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(1_000),
    code: PathSegmentSchema.optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();

export const ValidationEvidenceTerminalStateSchema = z
  .object({
    status: WorkflowRunStatusSchema,
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    error: ValidationEvidenceErrorSchema.optional(),
  })
  .strict();
export type ValidationEvidenceTerminalState = z.infer<typeof ValidationEvidenceTerminalStateSchema>;

export const ValidationEvidenceCheckpointSchema = z
  .object({
    reference: ValidationEvidenceReferenceSchema,
    checkpoint: z.string().trim().min(1).max(200),
  })
  .strict();
export type ValidationEvidenceCheckpoint = z.infer<typeof ValidationEvidenceCheckpointSchema>;

export const ValidationEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal('1'),
    campaignId: ValidationCampaignIdSchema,
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    projectId: PathSegmentSchema,
    runId: PathSegmentSchema,
    environmentReadiness: ValidationEnvironmentReadinessSchema,
    gates: z.array(ValidationEvidenceGateSchema).length(VALIDATION_EVIDENCE_GATE_IDS.length),
    attempts: z.array(ValidationEvidenceAttemptSchema).max(MAX_EVIDENCE_ATTEMPTS),
    usage: ValidationEvidenceUsageSchema,
    checkpoints: z.array(ValidationEvidenceCheckpointSchema).max(MAX_EVIDENCE_ATTEMPTS),
    deterministicResults: z.array(ValidationEvidenceGateSchema).max(2),
    browserEvidence: z.array(ValidationEvidenceReferenceSchema).max(MAX_EVIDENCE_REFERENCES),
    databaseEvidence: z.array(ValidationEvidenceReferenceSchema).max(MAX_EVIDENCE_REFERENCES),
    terminalState: ValidationEvidenceTerminalStateSchema,
    skippedGates: z.array(ValidationEvidenceGateIdSchema).max(VALIDATION_EVIDENCE_GATE_IDS.length),
    outcome: ValidationEvidenceOutcomeSchema,
    publishedAt: z.string().datetime(),
  })
  .strict();
export type ValidationEvidenceBundle = z.infer<typeof ValidationEvidenceBundleSchema>;

export const ValidationEvidenceResponseSchema = z
  .object({
    bundle: ValidationEvidenceBundleSchema,
    artifact: StoredArtifactSchema,
  })
  .strict();
export type ValidationEvidenceResponse = z.infer<typeof ValidationEvidenceResponseSchema>;
