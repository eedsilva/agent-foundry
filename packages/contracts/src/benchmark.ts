import { z } from 'zod';
import { DogfoodTaskSchema } from './dogfood.js';
import { ExecutionUsageSchema } from './run.js';
import { RouteDecisionSchema } from './model.js';

export const BenchmarkCaseKindSchema = z.enum([
  'greenfield',
  'existing-repo',
  'bug',
  'refactor',
  'review',
  'security-sensitive',
]);
export type BenchmarkCaseKind = z.infer<typeof BenchmarkCaseKindSchema>;
export const BENCHMARK_CASE_KINDS = BenchmarkCaseKindSchema.options;

// A benchmark case is a DogfoodTask (input + repo commit + policy via
// allowedFiles + checks via verifyScript) plus the two fields the v0.9
// benchmark runner needs on top: which corpus kind it represents and what a
// human reviewer should expect to see in a passing run.
export const BenchmarkCaseSchema = DogfoodTaskSchema.omit({ issueRef: true })
  .extend({
    kind: BenchmarkCaseKindSchema,
    expectedSignals: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type BenchmarkCase = z.infer<typeof BenchmarkCaseSchema>;

// BenchmarkRunRecord is built from DogfoodRunRecord but omitting taskId,
// issueRef, and humanEdit, and adding caseId, caseKind, modelId.
// We reconstruct manually because DogfoodRunRecordSchema has refinements
// and Zod v4 doesn't allow .omit() on refined schemas.
export const BenchmarkRunRecordSchema = z
  .object({
    schemaVersion: z.literal('1'),
    caseId: z.string().min(1),
    caseKind: BenchmarkCaseKindSchema,
    modelId: z.string().min(1),
    attempt: z.number().int().positive(),
    baselineRef: z.string(),
    projectId: z.string(),
    runId: z.string(),
    startedAt: z.string().datetime(),
    status: z.enum(['passed', 'failed']),
    durationMs: z.number().nonnegative(),
    route: RouteDecisionSchema.optional(),
    executedModel: z.string().optional(),
    usage: ExecutionUsageSchema.optional(),
    promptArtifact: z.string().optional(),
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
  })
  .strict()
  .superRefine((record, ctx) => {
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
  });
export type BenchmarkRunRecord = z.infer<typeof BenchmarkRunRecordSchema>;

export const BenchmarkReportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    baselineRef: z.string(),
    runs: z.array(BenchmarkRunRecordSchema).min(1),
    limitations: z.array(z.string()),
  })
  .strict();
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;
