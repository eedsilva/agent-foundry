import { z } from 'zod';
import { SanitizedErrorSchema } from './canary.js';
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
    // A canary fails without throwing, so the preflight report used to record
    // only "executedModel=missing" and the operator had to re-run the boundary
    // that costs quota to learn why (#592). The runner already classifies every
    // failure — carry that classification instead of dropping it at this seam.
    error: SanitizedErrorSchema.optional(),
  })
  .strict();
export type ValidationCanaryResult = z.infer<typeof ValidationCanaryResultSchema>;
