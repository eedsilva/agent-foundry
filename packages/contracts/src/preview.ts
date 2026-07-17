import { z } from 'zod';
import { PackageManagerSchema, PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema, EntityVersionSchema, RunErrorSchema } from './run.js';

export const PreviewSessionStatusSchema = z.enum([
  'preparing',
  'starting',
  'running',
  'unhealthy',
  'stopped',
  'failed',
  'expired',
]);
export type PreviewSessionStatus = z.infer<typeof PreviewSessionStatusSchema>;

export const PreviewHealthStateSchema = z.enum(['unknown', 'healthy', 'unhealthy']);
export type PreviewHealthState = z.infer<typeof PreviewHealthStateSchema>;

export const PreviewHealthSchema = z
  .object({
    state: PreviewHealthStateSchema,
    checkedAt: z.string().datetime().optional(),
    detail: z.string().optional(),
    consecutiveFailures: z.number().int().nonnegative().default(0),
  })
  .strict();
export type PreviewHealth = z.infer<typeof PreviewHealthSchema>;

export const PreviewProcessSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    pid: z.number().int().positive().optional(),
    port: z.number().int().min(1).max(65_535).optional(),
  })
  .strict();
export type PreviewProcess = z.infer<typeof PreviewProcessSchema>;

export const PreviewTtlSchema = z
  .object({
    seconds: z.number().int().positive(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();
export type PreviewTtl = z.infer<typeof PreviewTtlSchema>;

export const PreviewWorkspaceRefSchema = z
  .object({
    projectId: PathSegmentSchema,
    workspacePath: z.string().min(1),
    gitRef: z.string().min(1).optional(),
  })
  .strict();
export type PreviewWorkspaceRef = z.infer<typeof PreviewWorkspaceRefSchema>;

export const PreviewCommandResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.string().min(1),
    })
    .strict(),
]);
export type PreviewCommandResult = z.infer<typeof PreviewCommandResultSchema>;

export const PreviewToolVersionsSchema = z
  .object({
    node: z.string().min(1),
    packageManager: z.string().min(1).optional(),
  })
  .strict();
export type PreviewToolVersions = z.infer<typeof PreviewToolVersionsSchema>;

export const PreviewCommandPlanSchema = z
  .object({
    packageManager: PackageManagerSchema,
    install: PreviewCommandResultSchema,
    build: PreviewCommandResultSchema,
    dev: PreviewCommandResultSchema,
    versions: PreviewToolVersionsSchema.optional(),
    detectedAt: z.string().datetime(),
  })
  .strict();
export type PreviewCommandPlan = z.infer<typeof PreviewCommandPlanSchema>;

export const PreviewSessionSchema = z
  .object({
    id: PathSegmentSchema,
    runId: PathSegmentSchema.optional(),
    workspaceRef: PreviewWorkspaceRefSchema,
    status: PreviewSessionStatusSchema,
    version: EntityVersionSchema,
    url: z.string().url().optional(),
    process: PreviewProcessSchema.optional(),
    health: PreviewHealthSchema,
    ttl: PreviewTtlSchema,
    restartCount: z.number().int().nonnegative().default(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    error: RunErrorSchema.optional(),
    commandPlan: PreviewCommandPlanSchema.optional(),
  })
  .strict()
  .superRefine((session, context) => {
    const terminal =
      session.status === 'stopped' || session.status === 'failed' || session.status === 'expired';
    const serving = session.status === 'running' || session.status === 'unhealthy';
    if (serving) {
      if (!session.url) {
        context.addIssue({
          code: 'custom',
          path: ['url'],
          message: 'Serving session requires url',
        });
      }
      if (!session.process) {
        context.addIssue({
          code: 'custom',
          path: ['process'],
          message: 'Serving session requires process',
        });
      }
      if (!session.startedAt) {
        context.addIssue({
          code: 'custom',
          path: ['startedAt'],
          message: 'Serving session requires startedAt',
        });
      }
      if (!session.ttl.expiresAt) {
        context.addIssue({
          code: 'custom',
          path: ['ttl', 'expiresAt'],
          message: 'Serving session requires ttl.expiresAt',
        });
      }
    }
    if (session.status === 'expired' && !session.startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'Expired session must have served, so startedAt is required',
      });
    }
    if (terminal && !session.completedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Terminal session requires completedAt',
      });
    }
    if (!terminal && session.completedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'Non-terminal session cannot have completedAt',
      });
    }
    if (session.status === 'failed' && !session.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Failed session requires error',
      });
    }
    if (session.status !== 'failed' && session.error) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: 'Only failed sessions may retain an error',
      });
    }
    if (session.updatedAt < session.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt cannot precede createdAt',
      });
    }
    if (session.startedAt && session.startedAt < session.createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'startedAt cannot precede createdAt',
      });
    }
    if (session.completedAt && session.startedAt && session.completedAt < session.startedAt) {
      context.addIssue({
        code: 'custom',
        path: ['completedAt'],
        message: 'completedAt cannot precede startedAt',
      });
    }
  });
export type PreviewSession = z.infer<typeof PreviewSessionSchema>;

export const PreviewLogEntrySchema = z
  .object({
    cursor: z.number().int().positive(),
    stream: z.enum(['stdout', 'stderr']),
    message: z.string(),
    timestamp: z.string().datetime(),
  })
  .strict();
export type PreviewLogEntry = z.infer<typeof PreviewLogEntrySchema>;

export const PreviewLogPageSchema = z
  .object({
    entries: z.array(PreviewLogEntrySchema),
    nextCursor: z.number().int().nonnegative(),
    truncatedBeforeCursor: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((page, context) => {
    for (let index = 1; index < page.entries.length; index += 1) {
      if (page.entries[index]!.cursor <= page.entries[index - 1]!.cursor) {
        context.addIssue({
          code: 'custom',
          path: ['entries', index, 'cursor'],
          message: 'Log cursors must be strictly increasing',
        });
      }
    }
  });
export type PreviewLogPage = z.infer<typeof PreviewLogPageSchema>;

export const PreviewFailureDiagnosticSchema = z
  .object({
    schemaVersion: z.literal('1'),
    sessionId: PathSegmentSchema,
    projectId: PathSegmentSchema,
    runId: PathSegmentSchema.optional(),
    phase: z.enum(['prepare', 'start', 'health', 'runtime', 'reap']),
    health: PreviewHealthSchema,
    restartCount: z.number().int().nonnegative(),
    error: RunErrorSchema,
    logs: PreviewLogPageSchema,
    failedAt: z.string().datetime(),
  })
  .strict();
export type PreviewFailureDiagnostic = z.infer<typeof PreviewFailureDiagnosticSchema>;

export const PreviewEvidenceSchema = z
  .object({
    logs: ArtifactReferenceSchema.optional(),
    screenshots: z.array(ArtifactReferenceSchema).default([]),
    trace: ArtifactReferenceSchema.optional(),
  })
  .strict();
export type PreviewEvidence = z.infer<typeof PreviewEvidenceSchema>;

export const PreviewSessionReferenceSchema = z
  .object({
    sessionId: PathSegmentSchema,
    status: PreviewSessionStatusSchema,
    url: z.string().url().optional(),
    evidence: PreviewEvidenceSchema.default({ screenshots: [] }),
  })
  .strict();
export type PreviewSessionReference = z.infer<typeof PreviewSessionReferenceSchema>;
