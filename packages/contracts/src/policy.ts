import { z } from 'zod';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';

const BrowserOriginSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.hostname.includes('*') &&
      url.origin === value
    );
  } catch {
    return false;
  }
});

export const BrowserEvidencePolicySchema = z
  .object({
    captureTrace: z.boolean().default(false),
    captureVideo: z.boolean().default(false),
  })
  .strict();
export type BrowserEvidencePolicy = z.infer<typeof BrowserEvidencePolicySchema>;

export const DEFAULT_BROWSER_EVIDENCE_POLICY: BrowserEvidencePolicy =
  BrowserEvidencePolicySchema.parse({});

/**
 * Opts a project into the advisory UI-quality judge (#475). Absent means the
 * judge never runs: browser verification behaves exactly as it did before the
 * judge existed, and reports carry no `uiQuality` field.
 */
export const UiQualityJudgePolicySchema = z
  .object({
    provider: ProviderSchema,
    model: z.string().min(1),
    /**
     * Promotes the judge from advisory to a blocking gate (#477, ADR 0058): a
     * report whose uiQuality.overallScore falls below this value flips
     * `approved` to false, routing through the same repair loop a failed
     * functional check would. Absent (the default, including every policy
     * that only set `provider`/`model` under #475) keeps the judge purely
     * advisory — unchanged behavior.
     *
     * Best-effort, not fail-closed: if the judge is unavailable (outage,
     * timeout, no screenshots), `uiQuality` is left off the report and
     * `approved` stays exactly what functional verification computed — a
     * judge outage never blocks a run that otherwise passed.
     */
    minOverallScore: z.number().min(0).max(1).optional(),
  })
  .strict();
export type UiQualityJudgePolicy = z.infer<typeof UiQualityJudgePolicySchema>;

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
  previewCommands: z
    .object({
      build: z.string().min(1).optional(),
      dev: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
  browserAllowedOrigins: z.array(BrowserOriginSchema).min(1).optional(),
  browserEvidence: BrowserEvidencePolicySchema.optional(),
  uiQualityJudge: UiQualityJudgePolicySchema.optional(),
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
