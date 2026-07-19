import { z } from 'zod';
import { AgentRoleSchema, PathSegmentSchema, TaskKindSchema } from './primitives.js';
import { TaskCategorySchema, TaskTaxonomyVersionSchema } from './task-taxonomy.js';

const QualityArtifactReferenceSchema = z
  .object({
    name: PathSegmentSchema,
    revision: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const QualityObservationSourceSchema = z.enum([
  'deterministic',
  'blind-review',
  'human-edit',
  'post-merge-regression',
]);
export type QualityObservationSource = z.infer<typeof QualityObservationSourceSchema>;

export const QualityObservationQuerySchema = z
  .object({
    modelId: PathSegmentSchema,
    taskKind: TaskKindSchema,
    role: AgentRoleSchema,
    taxonomyVersion: TaskTaxonomyVersionSchema,
    category: TaskCategorySchema,
  })
  .strict();
export type QualityObservationQuery = z.infer<typeof QualityObservationQuerySchema>;

export const QualitySubjectSchema = QualityObservationQuerySchema.extend({
  artifact: QualityArtifactReferenceSchema,
}).strict();
export type QualitySubject = z.infer<typeof QualitySubjectSchema>;

export const QualityEvaluatorSchema = z
  .object({
    kind: z.enum(['deterministic', 'llm', 'human', 'system']),
    id: z.string().trim().min(1).max(200),
  })
  .strict();
export type QualityEvaluator = z.infer<typeof QualityEvaluatorSchema>;

export const QualityEvidenceSchema = z
  .object({
    kind: z.enum(['verification-report', 'review-artifact', 'human-edit', 'regression']),
    artifact: QualityArtifactReferenceSchema.optional(),
    summary: z.string().trim().min(1).max(2_000),
  })
  .strict();
export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;

export const QualityObservationSchema = z
  .object({
    id: PathSegmentSchema,
    source: QualityObservationSourceSchema,
    subject: QualitySubjectSchema,
    evaluator: QualityEvaluatorSchema,
    blind: z.boolean(),
    rubric: z.string().trim().min(1).max(200),
    score: z.number().min(0).max(1),
    evidence: z.array(QualityEvidenceSchema).min(1),
    observedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((observation, context) => {
    const expectedEvaluator =
      observation.source === 'deterministic'
        ? 'deterministic'
        : observation.source === 'blind-review'
          ? 'llm'
          : observation.source === 'human-edit'
            ? 'human'
            : 'system';
    if (observation.evaluator.kind !== expectedEvaluator) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluator', 'kind'],
        message: `${observation.source} requires a ${expectedEvaluator} evaluator`,
      });
    }
    if (observation.blind !== (observation.source === 'blind-review')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blind'],
        message: 'Only blind-review observations may be blind',
      });
    }
  });
export type QualityObservation = z.infer<typeof QualityObservationSchema>;

export const QualityObservationInputSchema = z
  .object({
    source: z.enum(['human-edit', 'post-merge-regression']),
    artifact: QualityArtifactReferenceSchema,
    evaluator: QualityEvaluatorSchema,
    rubric: z.string().trim().min(1).max(200),
    score: z.number().min(0).max(1),
    evidence: z.array(QualityEvidenceSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const expectedEvaluator = input.source === 'human-edit' ? 'human' : 'system';
    if (input.evaluator.kind !== expectedEvaluator) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluator', 'kind'],
        message: `${input.source} requires a ${expectedEvaluator} evaluator`,
      });
    }
  });
export type QualityObservationInput = z.infer<typeof QualityObservationInputSchema>;

export const QualitySignalComponentSchema = z
  .object({
    count: z.number().int().positive(),
    average: z.number().min(0).max(1),
  })
  .strict();
export type QualitySignalComponent = z.infer<typeof QualitySignalComponentSchema>;

export const QualitySignalSummarySchema = z
  .object({
    observations: z.array(QualityObservationSchema),
    components: z
      .object({
        deterministic: QualitySignalComponentSchema.optional(),
        blindReview: QualitySignalComponentSchema.optional(),
        humanEdit: QualitySignalComponentSchema.optional(),
        postMergeRegression: QualitySignalComponentSchema.optional(),
      })
      .strict(),
    aggregate: z.number().min(0).max(1).optional(),
  })
  .strict();
export type QualitySignalSummary = z.infer<typeof QualitySignalSummarySchema>;
