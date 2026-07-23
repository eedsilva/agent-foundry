import { z } from 'zod';
import {
  DogfoodRunRecordBaseSchema,
  DogfoodTaskSchema,
  dogfoodStatusFailureRefinement,
} from './dogfood.js';

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
export const BenchmarkRunRecordSchema = DogfoodRunRecordBaseSchema.omit({
  taskId: true,
  issueRef: true,
  humanEdit: true,
})
  .extend({
    caseId: z.string().min(1),
    caseKind: BenchmarkCaseKindSchema,
    modelId: z.string().min(1),
  })
  .strict()
  .superRefine(dogfoodStatusFailureRefinement);
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
