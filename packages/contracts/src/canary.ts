import { z } from 'zod';
import { ProviderSchema } from './primitives.js';

export const ProviderCanaryProviderSchema = ProviderSchema.exclude(['mock']);
export type ProviderCanaryProvider = z.infer<typeof ProviderCanaryProviderSchema>;

export const ProviderProbeStatusSchema = z.enum([
  'ready',
  'unavailable',
  'unauthenticated',
  'incompatible',
]);
export type ProviderProbeStatus = z.infer<typeof ProviderProbeStatusSchema>;

export const ProviderCapabilitiesSchema = z
  .object({
    nonInteractive: z.boolean(),
    modelSelection: z.boolean(),
    sandbox: z.boolean(),
  })
  .strict();
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderProbeSchema = z
  .object({
    provider: ProviderCanaryProviderSchema,
    status: ProviderProbeStatusSchema,
    version: z.string().min(1).optional(),
    capabilities: ProviderCapabilitiesSchema,
    message: z.string().min(1),
  })
  .strict();
export type ProviderProbe = z.infer<typeof ProviderProbeSchema>;

export const CanaryUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
  })
  .strict();
export type CanaryUsage = z.infer<typeof CanaryUsageSchema>;

export const CanaryVerificationResultSchema = z
  .object({
    name: z.string().min(1),
    passed: z.boolean(),
    exitCode: z.number().int().optional(),
    durationMs: z.number().nonnegative(),
    message: z.string().min(1).optional(),
  })
  .strict();
export type CanaryVerificationResult = z.infer<typeof CanaryVerificationResultSchema>;

export const SanitizedErrorSchema = z
  .object({
    kind: z.enum(['probe', 'invocation', 'execution', 'artifact', 'verification', 'unknown']),
    code: z.string().min(1).optional(),
    message: z.string().min(1),
  })
  .strict();
export type SanitizedError = z.infer<typeof SanitizedErrorSchema>;

export const CanaryScenarioSchema = z.enum(['planning', 'greenfield', 'repair']);
export type CanaryScenario = z.infer<typeof CanaryScenarioSchema>;

export const CanaryRunStatusSchema = z.enum(['passed', 'failed', 'skipped']);
export type CanaryRunStatus = z.infer<typeof CanaryRunStatusSchema>;

export const ProviderCanaryRunSchema = z
  .object({
    provider: ProviderCanaryProviderSchema,
    scenario: CanaryScenarioSchema,
    model: z.string().min(1),
    executedModel: z.string().min(1).optional(),
    status: CanaryRunStatusSchema,
    durationMs: z.number().nonnegative(),
    usage: CanaryUsageSchema.optional(),
    verification: z.array(CanaryVerificationResultSchema),
    skipReason: z.string().min(1).optional(),
    error: SanitizedErrorSchema.optional(),
  })
  .strict();
export type ProviderCanaryRun = z.infer<typeof ProviderCanaryRunSchema>;

export const ProviderAliasSchema = z
  .object({
    provider: ProviderCanaryProviderSchema,
    alias: z.string().min(1),
    model: z.string().min(1),
  })
  .strict();
export type ProviderAlias = z.infer<typeof ProviderAliasSchema>;

export const ProviderCanaryReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    probes: z.array(ProviderProbeSchema),
    runs: z.array(ProviderCanaryRunSchema),
    aliases: z.array(ProviderAliasSchema),
    limitations: z.array(z.string().min(1)),
  })
  .strict();
export type ProviderCanaryReport = z.infer<typeof ProviderCanaryReportSchema>;
