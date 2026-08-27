import { z } from 'zod';
import {
  PackageManagerSchema,
  ActorRefSchema,
  PathSegmentSchema,
  ProjectStatusSchema,
  ProviderSchema,
} from './primitives.js';
import { RouteDecisionSchema } from './model.js';

export const ProjectSchema = z.object({
  id: PathSegmentSchema,
  name: z.string().min(1),
  workflowId: PathSegmentSchema,
  policyId: PathSegmentSchema.default('default'),
  /** Operator-selected canonical source directory; absent only on legacy records. */
  projectDirectory: z.string().min(1).optional(),
  status: ProjectStatusSchema,
  version: z.number().int().positive().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentRunId: PathSegmentSchema.optional(),
  currentNodeId: PathSegmentSchema.optional(),
  error: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ArtifactMetadataSchema = z.object({
  projectId: PathSegmentSchema,
  name: PathSegmentSchema,
  revision: z.number().int().positive(),
  contentType: z.string(),
  createdAt: z.string().datetime(),
  createdBy: z.string(),
  runId: PathSegmentSchema.optional(),
  stepRunId: PathSegmentSchema.optional(),
  attemptId: PathSegmentSchema.optional(),
  kind: z.literal('feedback').optional(),
  actor: ActorRefSchema.optional(),
  sourceDecisionId: PathSegmentSchema.optional(),
  routeDecision: RouteDecisionSchema.optional(),
  idempotencyKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sha256: z.string(),
  storage: z.enum(['inline', 'blob']).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  expiresAt: z.string().datetime().optional(),
  blobDeleted: z.boolean().optional(),
});
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

export const StoredArtifactSchema = z.object({
  metadata: ArtifactMetadataSchema,
  content: z.unknown(),
});
export type StoredArtifact = z.infer<typeof StoredArtifactSchema>;

export const FeedbackArtifactSchema = z
  .object({
    schemaVersion: z.literal('1'),
    actor: ActorRefSchema,
    sourceRequestId: PathSegmentSchema,
    sourceDecisionId: PathSegmentSchema,
    runId: PathSegmentSchema,
    stepRunId: PathSegmentSchema,
    note: z.string(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type FeedbackArtifact = z.infer<typeof FeedbackArtifactSchema>;

export const PROVISIONING_FAILURE_LOG_MAX_BYTES = 8 * 1024;
export const PROVISIONING_FAILURE_PHASE_MAX_BYTES = 64;
export const PROVISIONING_FAILURE_SUMMARY_MAX_BYTES = 256;
export const PROVISIONING_FAILURE_CONTEXT_MAX_BYTES = 512;

function boundedProvisioningString(maxBytes: number, label: string) {
  return z
    .string()
    .min(1)
    .max(maxBytes)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `${label} must be at most ${maxBytes} UTF-8 bytes`,
    );
}

export const ProvisioningFailureDiagnosticSchema = z
  .object({
    schemaVersion: z.literal('1'),
    phase: boundedProvisioningString(PROVISIONING_FAILURE_PHASE_MAX_BYTES, 'phase'),
    exitCode: z.number().int().optional(),
    summary: boundedProvisioningString(PROVISIONING_FAILURE_SUMMARY_MAX_BYTES, 'summary'),
    context: boundedProvisioningString(PROVISIONING_FAILURE_CONTEXT_MAX_BYTES, 'context'),
    logs: boundedProvisioningString(PROVISIONING_FAILURE_LOG_MAX_BYTES, 'logs'),
  })
  .strict();
export type ProvisioningFailureDiagnostic = z.infer<typeof ProvisioningFailureDiagnosticSchema>;

export const ProjectEventSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    type: z.enum([
      'project.created',
      'scaffold.applied',
      'project.initialization_ready',
      'project.queued',
      'project.provisioning_started',
      'project.provisioned',
      'project.provisioning_failed',
      'project.started',
      'project.completed',
      'project.failed',
      'run.cancel_requested',
      'run.cancelled',
      'run.emergency_ceiling_reached',
      'run.technical_retry_exhausted',
      'run.call_budget_exhausted',
      'run.draft_discarded',
      'run.pause_requested',
      'run.paused',
      'run.resume_requested',
      'run.resume_blocked',
      'run.approval_requested',
      'run.approval_decided',
      'run.rejected',
      'step.reused',
      'step.retry_requested',
      'node.started',
      'node.completed',
      'node.failed',
      'quality.approved',
      'quality.repair_requested',
      'quality.deferred',
      'task.started',
      'task.completed',
      'task.failed',
      'agent.routed',
      'agent.started',
      'agent.completed',
      'agent.output_repaired',
      'agent.failed',
      'artifact.created',
      'verification.completed',
      'policy.violation',
      'git.checkpoint',
      'queue.job_recovered',
      'preview.crashed',
      'preview.restarted',
      'preview.failed',
      'preview.cleanup_failed',
      'preview.reaped',
      'operation.completed',
      'operation.failed',
      'validation.evidence_failed',
      'validation.operator_accepted',
    ]),
    createdAt: z.string().datetime(),
    nodeId: PathSegmentSchema.optional(),
    runId: PathSegmentSchema.optional(),
    message: z.string(),
    dedupeKey: z.string().min(1).optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .superRefine((event, ctx) => {
    const diagnostic = event.data.diagnostic;
    if (event.type !== 'project.provisioning_failed' || diagnostic === undefined) return;
    if (typeof diagnostic === 'string') return;
    if (!ProvisioningFailureDiagnosticSchema.safeParse(diagnostic).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['data', 'diagnostic'],
        message: 'project.provisioning_failed diagnostic must be a bounded versioned object',
      });
    }
  });
export type ProjectEvent = z.infer<typeof ProjectEventSchema>;

export const QueueLeaseSchema = z
  .object({
    workerId: PathSegmentSchema,
    fencingToken: z.number().int().positive(),
    heartbeatAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type QueueLease = z.infer<typeof QueueLeaseSchema>;

export const QueueJobSchema = z.object({
  id: PathSegmentSchema,
  type: z.enum(['run-project', 'run-conversation-operation']),
  projectId: PathSegmentSchema,
  workflowId: PathSegmentSchema,
  runId: PathSegmentSchema.optional(),
  operationId: PathSegmentSchema.optional(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  availableAt: z.string().datetime(),
  lastError: z.string().optional(),
  leaseEpoch: z.number().int().nonnegative().default(0),
  lease: QueueLeaseSchema.optional(),
  traceContext: z.record(z.string(), z.string()).optional(),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

export const VerificationCommandResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  skipped: z.boolean().default(false),
  skipReason: z.string().optional(),
  /**
   * Ran, but never gates: the auto-fix pre-pass repairs what a machine can
   * before the checks, and a formatter that exits non-zero is not a defect
   * for an agent to fix (#324).
   */
  advisory: z.boolean().default(false),
  /**
   * Why the command failed, set only when it did. `check` is the only value
   * that says anything about the code: the command ran to completion and
   * reported a real defect. Every other value is the run itself failing, so
   * the tree is still unjudged and there is nothing for repair to fix (#561).
   */
  failureKind: z
    .enum(['check', 'timeout', 'out-of-memory', 'signal', 'max-output', 'spawn'])
    .optional(),
});
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

export const VerificationReportSchema = z.object({
  schemaVersion: z.literal('1'),
  approved: z.boolean(),
  packageManager: PackageManagerSchema,
  summary: z.string(),
  commands: z.array(VerificationCommandResultSchema),
  createdAt: z.string().datetime(),
  /** The generated app's `git rev-parse HEAD`; absent outside a git repo or before the first commit. */
  commit: z.string().optional(),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const ProviderRateLimitSchema = z
  .object({
    limit: z.number().nonnegative().optional(),
    remaining: z.number().nonnegative().optional(),
    resetAt: z.string().datetime().optional(),
  })
  .strict();
export type ProviderRateLimit = z.infer<typeof ProviderRateLimitSchema>;

export const ExecutorHealthSchema = z.object({
  provider: ProviderSchema,
  available: z.boolean(),
  version: z.string().optional(),
  message: z.string(),
  rateLimit: ProviderRateLimitSchema.optional(),
});
export type ExecutorHealth = z.infer<typeof ExecutorHealthSchema>;
