import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema, WorkflowTaskKindSchema } from './primitives.js';

export const ValidationCampaignIdSchema = z.literal('real-todo-v1');
export type ValidationCampaignId = z.infer<typeof ValidationCampaignIdSchema>;

export const ValidationModelIdentitySchema = z
  .object({
    id: PathSegmentSchema,
    provider: ProviderSchema.exclude(['mock']),
    model: z.string().trim().min(1),
  })
  .strict();
export type ValidationModelIdentity = z.infer<typeof ValidationModelIdentitySchema>;

export const ValidationCampaignRouteSchema = z
  .object({
    taskKind: WorkflowTaskKindSchema,
    selected: ValidationModelIdentitySchema,
    fallbacks: z.array(ValidationModelIdentitySchema),
  })
  .strict();
export type ValidationCampaignRoute = z.infer<typeof ValidationCampaignRouteSchema>;

export const ValidationCampaignLimitsSchema = z
  .object({
    attemptsPerAgentStep: z.number().int().positive(),
    targetedRepairs: z.number().int().nonnegative(),
    activeTimeMinutes: z.number().int().positive(),
    meteredCostUsd: z.number().nonnegative(),
  })
  .strict();
export type ValidationCampaignLimits = z.infer<typeof ValidationCampaignLimitsSchema>;

export const ValidationCampaignPreviewSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: ValidationCampaignIdSchema,
    name: z.string().trim().min(1),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    allowedModels: z.array(ValidationModelIdentitySchema).length(2),
    routes: z.array(ValidationCampaignRouteSchema).min(1),
    limits: ValidationCampaignLimitsSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    const allowedById = new Map(preview.allowedModels.map((model) => [model.id, model]));
    for (const [routeIndex, route] of preview.routes.entries()) {
      const routeModels = [
        { path: ['selected'] as const, model: route.selected },
        ...route.fallbacks.map((model, fallbackIndex) => ({
          path: ['fallbacks', fallbackIndex] as const,
          model,
        })),
      ];
      for (const routeModel of routeModels) {
        const allowed = allowedById.get(routeModel.model.id);
        if (
          !allowed ||
          allowed.provider !== routeModel.model.provider ||
          allowed.model !== routeModel.model.model
        ) {
          context.addIssue({
            code: 'custom',
            path: ['routes', routeIndex, ...routeModel.path],
            message: `Route model ${routeModel.model.id} must match an allowed campaign identity`,
          });
        }
      }
    }
  });
export type ValidationCampaignPreview = z.infer<typeof ValidationCampaignPreviewSchema>;

/** Persisted snapshot used by an explicitly selected campaign run. */
export const ValidationCampaignExecutionSchema = z
  .object({
    preview: ValidationCampaignPreviewSchema,
    activeElapsedMs: z.number().int().nonnegative(),
    activeSince: z.string().datetime().optional(),
    targetedRepairs: z.number().int().nonnegative(),
  })
  .strict();
export type ValidationCampaignExecution = z.infer<typeof ValidationCampaignExecutionSchema>;

export function createValidationCampaignExecution(
  preview: ValidationCampaignPreview,
): ValidationCampaignExecution {
  return ValidationCampaignExecutionSchema.parse({
    preview,
    activeElapsedMs: 0,
    targetedRepairs: 0,
  });
}

export const ValidationCampaignResponseSchema = z
  .object({
    availableCampaigns: z.array(ValidationCampaignIdSchema),
    selectedCampaign: ValidationCampaignIdSchema.nullable(),
    preview: ValidationCampaignPreviewSchema.nullable(),
  })
  .strict();
export type ValidationCampaignResponse = z.infer<typeof ValidationCampaignResponseSchema>;
