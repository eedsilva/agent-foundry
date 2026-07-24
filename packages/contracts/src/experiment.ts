import { z } from 'zod';
import {
  AgentRoleSchema,
  PathSegmentSchema,
  ProviderSchema,
  TaskKindSchema,
} from './primitives.js';
import { TaskCategorySchema } from './task-taxonomy.js';
import { BenchmarkCaseKindSchema } from './benchmark.js';

// --- Production per-decision log -------------------------------------------
// Flattened, not the full RouteDecision: only the fields ModelMetric/RouteDecision
// don't already aggregate. Cost/quota stay on ModelMetric (FileMetricsRepository)
// to avoid duplicating a second cost ledger.
export const RouterDecisionLogEntrySchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    routeId: PathSegmentSchema,
    createdAt: z.string().datetime(),
    projectId: PathSegmentSchema,
    runId: PathSegmentSchema,
    nodeId: z.string().min(1),
    workflowId: z.string().min(1),
    harnessVersion: z.string().min(1),
    taskKind: TaskKindSchema,
    category: TaskCategorySchema,
    role: AgentRoleSchema,
    provider: ProviderSchema.exclude(['mock']),
    modelId: PathSegmentSchema,
    // No .min(1): matches ModelDefinitionSchema.model, which catalog entries
    // can interpolate to '' when their env var is unset (models/catalog.yaml's
    // codex/agy fast/default variants) — selectable in mock-executor-mode runs.
    model: z.string(),
    approved: z.boolean(),
    firstPass: z.boolean(),
    repairs: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    confidence: z.number().min(0).max(1).optional(),
    sampleSize: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RouterDecisionLogEntry = z.infer<typeof RouterDecisionLogEntrySchema>;

// PII-free export projection: drops every identifier that ties a row back to
// a specific project/run/node. There is no free-text field in the log entry
// by construction — keep it that way so this omit stays a sufficient boundary.
export const DecisionExportRowSchema = RouterDecisionLogEntrySchema.omit({
  id: true,
  routeId: true,
  projectId: true,
  runId: true,
  nodeId: true,
}).strip();
export type DecisionExportRow = z.infer<typeof DecisionExportRowSchema>;

// --- Experiment registry (records, does not execute traffic-splitting) -----
export const ExperimentVariantSchema = z
  .object({
    key: z.string().min(1),
    description: z.string().min(1),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model'), modelId: PathSegmentSchema }).strict(),
      z.object({ kind: z.literal('harness'), harnessVersion: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('catalog'), catalogRef: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type ExperimentVariant = z.infer<typeof ExperimentVariantSchema>;

export const ExperimentStopRuleSchema = z
  .object({
    metric: z.enum(['approval-rate', 'first-pass-rate', 'cost-usd', 'time-to-approved-ms']),
    comparator: z.enum(['gte', 'lte']),
    threshold: z.number(),
    minSamples: z.number().int().positive(),
  })
  .strict();
export type ExperimentStopRule = z.infer<typeof ExperimentStopRuleSchema>;

export const ExperimentRecordSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    hypothesis: z.string().min(1),
    variants: z.array(ExperimentVariantSchema).min(2),
    population: z
      .object({
        taskKinds: z.array(TaskKindSchema).min(1),
        targetSampleSize: z.number().int().positive(),
      })
      .strict(),
    stopRule: ExperimentStopRuleSchema,
    status: z.enum(['draft', 'running', 'stopped', 'concluded']),
    conclusion: z.string().optional(),
  })
  .strict();
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;

// --- Regression gate ---------------------------------------------------------
export const RegressionCaseDeltaSchema = z
  .object({
    caseId: z.string().min(1),
    modelId: z.string().min(1),
    baselineStatus: z.enum(['passed', 'failed']),
    freshStatus: z.enum(['passed', 'failed']),
    statusRegressed: z.boolean(),
    durationDeltaMs: z.number(),
    repairsDelta: z.number().int(),
  })
  .strict();
export type RegressionCaseDelta = z.infer<typeof RegressionCaseDeltaSchema>;

export const RegressionGateResultSchema = z
  .object({
    schemaVersion: z.literal('1'),
    createdAt: z.string().datetime(),
    baselineRef: z.string(),
    freshCreatedAt: z.string().datetime(),
    verdict: z.enum(['pass', 'fail']),
    reasons: z.array(z.string()),
    deltas: z.array(RegressionCaseDeltaSchema),
  })
  .strict();
export type RegressionGateResult = z.infer<typeof RegressionGateResultSchema>;

// Re-exported purely so callers building fresh reports can reference it
// without importing benchmark.ts directly.
export { BenchmarkCaseKindSchema };
