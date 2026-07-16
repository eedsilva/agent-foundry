import { z } from 'zod';
import {
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

export const ProjectEventSchema = z.object({
  id: PathSegmentSchema,
  projectId: PathSegmentSchema,
  type: z.enum([
    'project.created',
    'project.queued',
    'project.started',
    'project.completed',
    'project.failed',
    'run.cancel_requested',
    'run.cancelled',
    'run.emergency_ceiling_reached',
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
    'agent.routed',
    'agent.started',
    'agent.completed',
    'agent.failed',
    'artifact.created',
    'verification.completed',
    'policy.violation',
    'git.checkpoint',
    'queue.job_recovered',
  ]),
  createdAt: z.string().datetime(),
  nodeId: PathSegmentSchema.optional(),
  runId: PathSegmentSchema.optional(),
  message: z.string(),
  dedupeKey: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
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
  type: z.literal('run-project'),
  projectId: PathSegmentSchema,
  workflowId: PathSegmentSchema,
  runId: PathSegmentSchema.optional(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  availableAt: z.string().datetime(),
  lastError: z.string().optional(),
  leaseEpoch: z.number().int().nonnegative().default(0),
  lease: QueueLeaseSchema.optional(),
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
});
export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;

export const VerificationReportSchema = z.object({
  schemaVersion: z.literal('1'),
  approved: z.boolean(),
  packageManager: z.enum(['npm', 'pnpm', 'yarn', 'bun', 'unknown']),
  summary: z.string(),
  commands: z.array(VerificationCommandResultSchema),
  createdAt: z.string().datetime(),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;

export const ExecutorHealthSchema = z.object({
  provider: ProviderSchema,
  available: z.boolean(),
  version: z.string().optional(),
  message: z.string(),
});
export type ExecutorHealth = z.infer<typeof ExecutorHealthSchema>;
