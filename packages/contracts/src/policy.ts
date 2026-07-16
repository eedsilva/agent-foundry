import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';

/**
 * Hard constraints a project executes under, validated before (router,
 * stack) and after (verifier) execution. Absent optional fields mean
 * "unrestricted"; empty allowlists are rejected as almost certainly a
 * configuration mistake (they would forbid everything).
 */
export const ProjectPolicySchema = z.object({
  schemaVersion: z.literal('1'),
  id: PathSegmentSchema,
  version: z.number().int().positive(),
  requiredStack: PathSegmentSchema.optional(),
  allowedProviders: z
    .array(ProviderSchema.exclude(['mock']))
    .min(1)
    .optional(),
  forbiddenDependencies: z.array(z.string().min(1)).default([]),
  allowedCommands: z.array(z.string().min(1)).min(1).optional(),
});
export type ProjectPolicy = z.infer<typeof ProjectPolicySchema>;

/** Identity of the policy a run executes under; the hash pins exact content. */
export const PolicyRecordSchema = z
  .object({
    id: PathSegmentSchema,
    version: z.number().int().positive(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PolicyRecord = z.infer<typeof PolicyRecordSchema>;
