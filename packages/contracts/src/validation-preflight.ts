import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';
import { ValidationCampaignIdSchema } from './validation-campaign.js';

export const ValidationPreflightBoundarySchema = z.enum([
  'source-revision',
  'data-directory',
  'executor-mode',
  'disposable-environment',
  'docker',
  'supabase',
  'scaffold',
  'application-health',
  'preview-gateway',
  'cleanup',
  'haiku-canary',
  'luna-canary',
]);
export type ValidationPreflightBoundary = z.infer<typeof ValidationPreflightBoundarySchema>;

export const ValidationPreflightStatusSchema = z.enum([
  'passed',
  'environment-blocked',
  'model-failed',
]);
export type ValidationPreflightStatus = z.infer<typeof ValidationPreflightStatusSchema>;

export const ValidationPreflightCheckSchema = z
  .object({
    boundary: ValidationPreflightBoundarySchema,
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().int().nonnegative(),
    message: z.string().min(1).optional(),
    errorCode: PathSegmentSchema.optional(),
    provider: ProviderSchema.optional(),
    selectedModel: z.string().min(1).optional(),
    executedModel: z.string().min(1).optional(),
  })
  .strict();
export type ValidationPreflightCheck = z.infer<typeof ValidationPreflightCheckSchema>;

export const ValidationPreflightReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    campaignId: ValidationCampaignIdSchema,
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    dataDirectory: z.string().min(1),
    executorMode: z.enum(['real', 'mock']),
    environmentId: PathSegmentSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    status: ValidationPreflightStatusSchema,
    checks: z.array(ValidationPreflightCheckSchema).min(1),
    generatedProjectCreated: z.literal(false),
  })
  .strict();
export type ValidationPreflightReport = z.infer<typeof ValidationPreflightReportSchema>;

export const ValidationCanaryResultSchema = z
  .object({
    provider: ProviderSchema.exclude(['mock']),
    selectedModel: z.string().min(1),
    executedModel: z.string().min(1).optional(),
    status: z.enum(['passed', 'failed']),
  })
  .strict();
export type ValidationCanaryResult = z.infer<typeof ValidationCanaryResultSchema>;
