import { z } from 'zod';
import {
  ActorRefSchema,
  AgentRoleSchema,
  ComplexityLevelSchema,
  PathSegmentSchema,
  ProviderSchema,
  RiskLevelSchema,
  TaskKindSchema,
} from './primitives.js';
import {
  TaskCategorySchema,
  TaskFeatureSchema,
  TaskTaxonomyVersionSchema,
  isTaskCategoryCompatible,
  legacyTaskCategory,
} from './task-taxonomy.js';
import { QualitySignalSummarySchema } from './quality.js';

export const CapabilityScoresSchema = z.object({
  planning: z.number().min(0).max(1),
  architecture: z.number().min(0).max(1),
  coding: z.number().min(0).max(1),
  review: z.number().min(0).max(1),
  repair: z.number().min(0).max(1),
  structuredOutput: z.number().min(0).max(1),
  speed: z.number().min(0).max(1),
  costEfficiency: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
});
export type CapabilityScores = z.infer<typeof CapabilityScoresSchema>;

export const ModelPricingSchema = z.object({
  inputUsdPerMillionTokens: z.number().nonnegative(),
  outputUsdPerMillionTokens: z.number().nonnegative(),
  cachedInputUsdPerMillionTokens: z.number().nonnegative().optional(),
});
export type ModelPricing = z.infer<typeof ModelPricingSchema>;

export const ModelDefinitionSchema = z.object({
  id: PathSegmentSchema,
  provider: ProviderSchema.exclude(['mock']),
  model: z.string(),
  billingMode: z.enum(['subscription', 'metered', 'unknown']).default('subscription'),
  pricing: ModelPricingSchema.optional(),
  enabled: z.boolean().default(true),
  requireExplicitModel: z.boolean().default(false),
  maxContextTokens: z.number().int().positive(),
  canWriteWorkspace: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  capabilities: CapabilityScoresSchema,
});
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

export const ModelCatalogSchema = z.object({
  schemaVersion: z.literal('1'),
  models: z.array(ModelDefinitionSchema).min(1),
});
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

export const RoutingPrioritiesSchema = z.object({
  quality: z.number().min(0).max(1),
  speed: z.number().min(0).max(1),
  cost: z.number().min(0).max(1),
  reliability: z.number().min(0).max(1),
});
export type RoutingPriorities = z.infer<typeof RoutingPrioritiesSchema>;

export const TaskProfileSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const profile = value as Record<string, unknown>;
    const taskKind = TaskKindSchema.safeParse(profile.taskKind);
    return {
      ...profile,
      taxonomyVersion: profile.taxonomyVersion === undefined ? '1' : profile.taxonomyVersion,
      category:
        profile.category === undefined && taskKind.success
          ? legacyTaskCategory(taskKind.data)
          : profile.category,
      features: profile.features === undefined ? [] : profile.features,
      toolPolicy:
        profile.toolPolicy === undefined
          ? profile.mutatesWorkspace === true
            ? 'workspace-write'
            : 'read-only'
          : profile.toolPolicy,
    };
  },
  z
    .object({
      role: AgentRoleSchema,
      taskKind: TaskKindSchema,
      taxonomyVersion: TaskTaxonomyVersionSchema,
      category: TaskCategorySchema,
      features: z.array(TaskFeatureSchema),
      complexity: ComplexityLevelSchema,
      risk: RiskLevelSchema,
      estimatedContextTokens: z.number().int().nonnegative(),
      estimatedOutputTokens: z.number().int().nonnegative(),
      mutatesWorkspace: z.boolean(),
      toolPolicy: z.enum(['read-only', 'workspace-write']),
      priorities: RoutingPrioritiesSchema,
      allowedProviders: z.array(ProviderSchema.exclude(['mock'])).optional(),
      policy: z
        .object({
          id: PathSegmentSchema,
          version: z.number().int().positive(),
          allowedProviders: z.array(ProviderSchema.exclude(['mock'])),
        })
        .strict()
        .optional(),
      preferredTags: z.array(z.string()).default([]),
    })
    .refine((profile) => isTaskCategoryCompatible(profile.taskKind, profile.category), {
      message: 'Category is incompatible with taskKind',
      path: ['category'],
    }),
);
export type TaskProfile = z.infer<typeof TaskProfileSchema>;

export const RouteScoreBreakdownSchema = z.object({
  capability: z.number(),
  context: z.number(),
  speed: z.number(),
  cost: z.number(),
  reliability: z.number(),
  historical: z.number(),
  tagAffinity: z.number(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  total: z.number(),
});
export type RouteScoreBreakdown = z.infer<typeof RouteScoreBreakdownSchema>;

export const RouteConfidenceSchema = z
  .object({
    value: z.number().min(0).max(1),
    sampleSize: z.number().int().nonnegative(),
    interval: z
      .object({
        lower: z.number().min(0).max(1),
        upper: z.number().min(0).max(1),
      })
      .strict(),
    coldStart: z.boolean(),
    rationale: z.string().trim().min(1),
  })
  .strict();
export type RouteConfidence = z.infer<typeof RouteConfidenceSchema>;

export const RankedModelSchema = z.object({
  model: ModelDefinitionSchema,
  score: RouteScoreBreakdownSchema,
  quality: QualitySignalSummarySchema.optional(),
  confidence: RouteConfidenceSchema.optional(),
});
export type RankedModel = z.infer<typeof RankedModelSchema>;

export const CalibrationBucketSchema = z
  .object({
    lower: z.number().min(0).max(1),
    upper: z.number().min(0).max(1),
    predictedMean: z.number().min(0).max(1),
    observedApprovalRate: z.number().min(0).max(1),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationBucket = z.infer<typeof CalibrationBucketSchema>;

export const CalibrationReportSchema = z
  .object({
    buckets: z.array(CalibrationBucketSchema),
    expectedCalibrationError: z.number().min(0).max(1),
    sampleSize: z.number().int().nonnegative(),
  })
  .strict();
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;

export const ModelOverrideScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run') }).strict(),
  z
    .object({
      kind: z.literal('step'),
      nodeId: PathSegmentSchema,
      stepId: PathSegmentSchema,
    })
    .strict(),
]);
export type ModelOverrideScope = z.infer<typeof ModelOverrideScopeSchema>;

export const ModelOverrideRecordSchema = z
  .object({
    id: PathSegmentSchema,
    runId: PathSegmentSchema,
    sequence: z.number().int().positive().default(1),
    scope: ModelOverrideScopeSchema,
    modelId: PathSegmentSchema,
    provider: ProviderSchema.exclude(['mock']),
    model: z.string().trim().min(1),
    actor: ActorRefSchema,
    reason: z.string().trim().min(1),
    estimatedImpact: z.string().trim().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ModelOverrideRecord = z.infer<typeof ModelOverrideRecordSchema>;

const RouteOverrideProvenanceShape = {
  modelId: PathSegmentSchema,
  provider: ProviderSchema.exclude(['mock']),
  model: z.string().trim().min(1),
  actor: ActorRefSchema,
  reason: z.string().trim().min(1),
  estimatedImpact: z.string().trim().min(1),
  createdAt: z.string().datetime(),
};

export const RouteOverrideProvenanceSchema = z.discriminatedUnion('source', [
  z
    .object({
      ...RouteOverrideProvenanceShape,
      source: z.literal('retry'),
      overrideId: PathSegmentSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...RouteOverrideProvenanceShape,
      source: z.literal('step'),
      overrideId: PathSegmentSchema,
    })
    .strict(),
  z
    .object({
      ...RouteOverrideProvenanceShape,
      source: z.literal('run'),
      overrideId: PathSegmentSchema,
    })
    .strict(),
]);
export type RouteOverrideProvenance = z.infer<typeof RouteOverrideProvenanceSchema>;

export const RouteDecisionSchema = z.object({
  routeId: PathSegmentSchema,
  createdAt: z.string().datetime(),
  profile: TaskProfileSchema,
  selected: RankedModelSchema,
  fallbacks: z.array(RankedModelSchema),
  executed: RankedModelSchema.optional(),
  attemptedModelIds: z.array(z.string().min(1)).optional(),
  override: RouteOverrideProvenanceSchema.optional(),
  rejected: z.array(
    z.object({
      modelId: PathSegmentSchema,
      reason: z.string(),
    }),
  ),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const ModelMetricSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const metric = value as Record<string, unknown>;
    const taskKind = TaskKindSchema.safeParse(metric.taskKind);
    return {
      ...metric,
      taxonomyVersion: metric.taxonomyVersion === undefined ? '1' : metric.taxonomyVersion,
      category:
        metric.category === undefined && taskKind.success
          ? legacyTaskCategory(taskKind.data)
          : metric.category,
    };
  },
  z
    .object({
      modelId: PathSegmentSchema,
      taskKind: TaskKindSchema,
      role: AgentRoleSchema,
      taxonomyVersion: TaskTaxonomyVersionSchema,
      category: TaskCategorySchema,
      attempts: z.number().int().nonnegative(),
      successes: z.number().int().nonnegative(),
      totalDurationMs: z.number().nonnegative(),
      totalInputTokens: z.number().nonnegative(),
      totalOutputTokens: z.number().nonnegative(),
      totalEstimatedCostUsd: z.number().nonnegative(),
      consecutiveFailures: z.number().int().nonnegative(),
      qualityEvaluations: z.number().int().nonnegative().default(0),
      qualityApprovals: z.number().int().nonnegative().default(0),
      quotaUnitsTotal: z.number().nonnegative().optional(),
      inputTokensKnownCount: z.number().int().nonnegative().optional(),
      outputTokensKnownCount: z.number().int().nonnegative().optional(),
      cachedInputTokensKnownCount: z.number().int().nonnegative().optional(),
      costKnownCount: z.number().int().nonnegative().optional(),
      quotaUnitsKnownCount: z.number().int().nonnegative().optional(),
      lastFailureAt: z.string().datetime().optional(),
      updatedAt: z.string().datetime(),
    })
    .refine((metric) => isTaskCategoryCompatible(metric.taskKind, metric.category), {
      message: 'Category is incompatible with taskKind',
      path: ['category'],
    }),
);
export type ModelMetric = z.infer<typeof ModelMetricSchema>;
