import { z } from 'zod';
import { RouteDecisionSchema } from './model.js';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';

export const EntityVersionSchema = z.number().int().positive();

export const WorkflowRunStatusSchema = z.enum([
  'queued',
  'running',
  'pause_requested',
  'paused',
  'cancel_requested',
  'cancelled',
  'completed',
  'failed',
]);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

export const StepRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);
export type StepRunStatus = z.infer<typeof StepRunStatusSchema>;

export const StepAttemptStatusSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type StepAttemptStatus = z.infer<typeof StepAttemptStatusSchema>;

export const RunErrorSchema = z
  .object({
    name: z.string().min(1),
    message: z.string().min(1),
    code: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
  })
  .strict();
export type RunError = z.infer<typeof RunErrorSchema>;

export const ExecutionUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>;

export const ArtifactReferenceSchema = z
  .object({
    name: PathSegmentSchema,
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const IdempotencyKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Compatibility snapshot captured when a run pauses. Resume compares each
 * field against the live system and blocks with a diagnostic on mismatch.
 */
export const RunPauseSnapshotSchema = z
  .object({
    workflowHash: IdempotencyKeySchema,
    harnessVersion: z.string().min(1),
    workspaceHead: z.string().min(1).nullable(),
    artifactHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    resumeNodeId: PathSegmentSchema.optional(),
  })
  .strict();
export type RunPauseSnapshot = z.infer<typeof RunPauseSnapshotSchema>;

export const RunRetryDirectiveSchema = z
  .object({
    stepRunId: PathSegmentSchema,
    nodeId: PathSegmentSchema,
    stepId: PathSegmentSchema,
    iteration: z.number().int().positive().optional(),
    mode: z.enum(['preserve', 'invalidate']),
    override: z
      .object({
        modelId: PathSegmentSchema,
        provider: ProviderSchema.exclude(['mock']),
        model: z.string(),
      })
      .strict()
      .optional(),
    checkpoint: z.string().min(1).optional(),
    requestedAt: z.string().datetime(),
  })
  .strict();
export type RunRetryDirective = z.infer<typeof RunRetryDirectiveSchema>;

export const WorkflowRunSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    workflowId: PathSegmentSchema,
    status: WorkflowRunStatusSchema,
    version: EntityVersionSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    currentStepRunId: PathSegmentSchema.optional(),
    error: RunErrorSchema.optional(),
    pause: RunPauseSnapshotSchema.optional(),
    retry: RunRetryDirectiveSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    validateLifecycleTimestamps(run.status, run, context, {
      initial: ['queued'],
      terminal: ['completed', 'failed', 'cancelled'],
    });
    if (run.status === 'failed' && !run.error) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'Failed run requires error' });
    }
    if (run.status !== 'failed' && run.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed runs may retain an error',
      });
    }
    if (run.pause && run.status !== 'paused') {
      context.addIssue({
        code: 'custom',
        path: ['pause'],
        message: 'Only paused runs may retain a pause snapshot',
      });
    }
    if (run.retry && ['completed', 'failed', 'cancelled'].includes(run.status)) {
      context.addIssue({
        code: 'custom',
        path: ['retry'],
        message: 'Terminal runs may not retain a retry directive',
      });
    }
  });
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export const StepRunSchema = z
  .object({
    id: PathSegmentSchema,
    runId: PathSegmentSchema,
    nodeId: PathSegmentSchema,
    stepId: PathSegmentSchema,
    stepType: z.enum(['agent', 'verify']),
    iteration: z.number().int().positive().optional(),
    status: StepRunStatusSchema,
    version: EntityVersionSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
    invalidatedAt: z.string().datetime().optional(),
    invalidationReason: z.string().min(1).optional(),
    error: RunErrorSchema.optional(),
  })
  .strict()
  .superRefine((step, context) => {
    validateLifecycleTimestamps(step.status, step, context, {
      initial: ['pending', 'skipped', 'cancelled'],
      terminal: ['completed', 'failed', 'cancelled', 'skipped'],
    });
    if (step.status === 'failed' && !step.error) {
      context.addIssue({ code: 'custom', path: ['error'], message: 'Failed step requires error' });
    }
    if (step.status !== 'failed' && step.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed steps may retain an error',
      });
    }
  });
export type StepRun = z.infer<typeof StepRunSchema>;

export const StepAttemptSchema = z
  .object({
    id: PathSegmentSchema,
    runId: PathSegmentSchema,
    stepRunId: PathSegmentSchema,
    sequence: z.number().int().positive(),
    executorKind: z.enum(['agent', 'verification']),
    provider: ProviderSchema.or(z.literal('internal')),
    model: z.string().min(1),
    executedModel: z.string().min(1).optional(),
    modelId: PathSegmentSchema.optional(),
    status: StepAttemptStatusSchema,
    version: EntityVersionSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    checkpoint: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
    durationMs: z.number().nonnegative().optional(),
    usage: ExecutionUsageSchema.optional(),
    error: RunErrorSchema.optional(),
    routeDecision: RouteDecisionSchema.optional(),
    previewSessionId: PathSegmentSchema.optional(),
    harness: z
      .object({
        version: z.string().min(1),
        files: z.array(z.object({ path: z.string().min(1), priority: z.number().int() }).strict()),
      })
      .strict()
      .optional(),
    context: z
      .object({
        projectId: PathSegmentSchema,
        workflowId: PathSegmentSchema,
        nodeId: PathSegmentSchema,
        stepId: PathSegmentSchema,
        iteration: z.number().int().positive().optional(),
      })
      .strict(),
    inputArtifacts: z.array(ArtifactReferenceSchema).default([]),
    outputArtifacts: z.array(ArtifactReferenceSchema).default([]),
  })
  .strict()
  .superRefine((attempt, context) => {
    validateLifecycleTimestamps(attempt.status, attempt, context, {
      initial: ['running'],
      terminal: ['succeeded', 'failed', 'cancelled'],
      startedAtRequiredForInitial: true,
    });
    if (attempt.status === 'failed' && !attempt.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed attempt requires error',
      });
    }
    if (attempt.status !== 'failed' && attempt.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed attempts may retain an error',
      });
    }
    if (attempt.executorKind === 'verification') {
      if (attempt.provider !== 'internal' || attempt.model !== 'workspace-verifier') {
        context.addIssue({
          code: 'custom',
          path: ['provider'],
          message: 'Verification attempts use internal/workspace-verifier',
        });
      }
    } else if (attempt.provider === 'internal') {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'Agent attempts require an agent provider',
      });
    }
  });
export type StepAttempt = z.infer<typeof StepAttemptSchema>;

function validateLifecycleTimestamps(
  status: string,
  value: {
    createdAt: string;
    updatedAt: string;
    startedAt?: string | undefined;
    completedAt?: string | undefined;
  },
  context: z.RefinementCtx,
  options: {
    initial: string[];
    terminal: string[];
    startedAtRequiredForInitial?: boolean;
  },
): void {
  const terminal = options.terminal.includes(status);
  const initial = options.initial.includes(status);
  if ((!initial || options.startedAtRequiredForInitial) && !value.startedAt) {
    context.addIssue({
      code: 'custom',
      path: ['startedAt'],
      message: 'Started state requires startedAt',
    });
  }
  if (terminal && !value.completedAt) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'Terminal state requires completedAt',
    });
  }
  if (!terminal && value.completedAt) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'Non-terminal state cannot have completedAt',
    });
  }
  if (value.startedAt && value.completedAt && value.completedAt < value.startedAt) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completedAt cannot precede startedAt',
    });
  }
  if (value.updatedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['updatedAt'],
      message: 'updatedAt cannot precede createdAt',
    });
  }
  if (value.startedAt && value.startedAt < value.createdAt) {
    context.addIssue({
      code: 'custom',
      path: ['startedAt'],
      message: 'startedAt cannot precede createdAt',
    });
  }
  if (value.completedAt && value.completedAt > value.updatedAt) {
    context.addIssue({
      code: 'custom',
      path: ['completedAt'],
      message: 'completedAt cannot follow updatedAt',
    });
  }
}
