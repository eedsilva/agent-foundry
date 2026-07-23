import { z } from 'zod';
import { RouteDecisionSchema } from './model.js';
import { ExecutionUsageSchema } from './run.js';

export const DogfoodTaskSchema = z
  .object({
    id: z.string().min(1), // e.g. 'domain-redaction'
    title: z.string().min(1),
    issueRef: z.string().min(1), // e.g. 'eedsilva/agent-foundry#10'
    workflowId: z.string().min(1), // 'dogfood-task-v1' | 'dogfood-plan-v1'
    prompt: z.string().min(50), // becomes the project PRD
    baselineRef: z.string().min(7), // git ref the workspace is seeded from
    allowedFiles: z.array(z.string().min(1)), // paths the agent may create/modify ([] = no diff allowed)
    seedFiles: z
      .array(z.object({ path: z.string().min(1), content: z.string() }).strict())
      .default([]),
    verifyScript: z.string().min(1).optional(), // value injected as package.json "dogfood:verify"
  })
  .strict();
export type DogfoodTask = z.infer<typeof DogfoodTaskSchema>;

export const DogfoodHumanEditSchema = z
  .object({
    status: z.enum(['pending', 'recorded']),
    reference: z.string().optional(), // merged ref/PR the comparison used
    files: z
      .array(
        z
          .object({
            path: z.string(),
            agentVsMerged: z.enum(['same', 'modified', 'absent', 'agent-only']),
          })
          .strict(),
      )
      .default([]),
    notes: z.string().optional(),
  })
  .strict();
export type DogfoodHumanEdit = z.infer<typeof DogfoodHumanEditSchema>;

export const DogfoodRunRecordBaseSchema = z
  .object({
    schemaVersion: z.literal('1'),
    taskId: z.string(),
    attempt: z.number().int().positive(), // 1, 2… — reruns append, never overwrite
    issueRef: z.string(),
    baselineRef: z.string(),
    projectId: z.string(),
    runId: z.string(),
    startedAt: z.string().datetime(),
    status: z.enum(['passed', 'failed']), // passed = run completed AND verification approved AND allowlist respected
    durationMs: z.number().nonnegative(),
    route: RouteDecisionSchema.optional(), // from the implementation StepAttempt
    executedModel: z.string().optional(),
    usage: ExecutionUsageSchema.optional(),
    promptArtifact: z.string().optional(), // artifact name holding REQUEST.md (audit trail)
    diff: z
      .object({
        checkpoint: z.string().optional(),
        commit: z.string().optional(),
        stat: z.string(),
        filesChanged: z.array(z.string()),
      })
      .strict()
      .optional(),
    checks: z
      .array(
        z
          .object({
            name: z.string(),
            exitCode: z.number().nullable(),
            durationMs: z.number().nonnegative(),
            skipped: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    repairs: z
      .object({
        iterations: z.number().int().nonnegative(),
        repairEvents: z.number().int().nonnegative(),
      })
      .strict(),
    failure: z
      .object({ kind: z.string(), code: z.string().optional(), message: z.string() })
      .strict()
      .optional(),
    humanEdit: DogfoodHumanEditSchema,
  })
  .strict();

export function dogfoodStatusFailureRefinement(
  record: {
    status: 'passed' | 'failed';
    failure?: { kind: string; code?: string | undefined; message: string } | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (record.status === 'failed' && !record.failure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status: 'failed' requires failure to be present",
      path: ['failure'],
    });
  }
  if (record.status === 'passed' && record.failure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "status: 'passed' requires failure to be absent",
      path: ['failure'],
    });
  }
}

export const DogfoodRunRecordSchema = DogfoodRunRecordBaseSchema.superRefine(
  dogfoodStatusFailureRefinement,
);
export type DogfoodRunRecord = z.infer<typeof DogfoodRunRecordSchema>;

export const DogfoodReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    baselineRef: z.string(),
    runs: z.array(DogfoodRunRecordSchema).min(1),
    limitations: z.array(z.string()),
  })
  .strict();
export type DogfoodReport = z.infer<typeof DogfoodReportSchema>;
