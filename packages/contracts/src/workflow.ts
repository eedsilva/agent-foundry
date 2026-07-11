import { z } from 'zod';
import { AgentRoleSchema, PathSegmentSchema, TaskKindSchema } from './primitives.js';
import { RoutingPrioritiesSchema } from './model.js';

export const ArtifactConditionSchema = z.object({
  artifact: PathSegmentSchema,
  path: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type ArtifactCondition = z.infer<typeof ArtifactConditionSchema>;

const AgentStepSchema = z.object({
  id: PathSegmentSchema,
  type: z.literal('agent'),
  role: AgentRoleSchema,
  taskKind: TaskKindSchema,
  title: z.string().min(1),
  instructions: z.string().min(1),
  inputArtifacts: z.array(PathSegmentSchema).default([]),
  outputArtifact: PathSegmentSchema,
  mutatesWorkspace: z.boolean().default(false),
  harnessTags: z.array(z.string()).default([]),
  profile: z
    .object({
      complexity: z.number().int().min(1).max(5).optional(),
      risk: z.number().int().min(1).max(5).optional(),
      priorities: RoutingPrioritiesSchema.partial().optional(),
      allowedProviders: z.array(z.enum(['codex', 'claude', 'agy'])).optional(),
      preferredTags: z.array(z.string()).optional(),
    })
    .default({}),
  maxAttempts: z.number().int().min(1).max(5).default(2),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;

const VerifyStepSchema = z.object({
  id: PathSegmentSchema,
  type: z.literal('verify'),
  title: z.string().min(1),
  outputArtifact: PathSegmentSchema,
  scripts: z.array(z.string()).default(['typecheck', 'lint', 'test', 'build']),
  includeGitDiffCheck: z.boolean().default(true),
});
export type VerifyStep = z.infer<typeof VerifyStepSchema>;

export const ExecutableStepSchema = z.discriminatedUnion('type', [
  AgentStepSchema,
  VerifyStepSchema,
]);
export type ExecutableStep = z.infer<typeof ExecutableStepSchema>;

const QualityLoopStepSchema = z.object({
  id: PathSegmentSchema,
  type: z.literal('quality-loop'),
  title: z.string().min(1),
  setup: ExecutableStepSchema.optional(),
  check: ExecutableStepSchema,
  repair: AgentStepSchema,
  approval: ArtifactConditionSchema,
  maxIterations: z.number().int().min(1).max(10).default(2),
});
export type QualityLoopStep = z.infer<typeof QualityLoopStepSchema>;

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  AgentStepSchema,
  VerifyStepSchema,
  QualityLoopStepSchema,
]);
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>;

export const WorkflowDefinitionSchema = z.object({
  schemaVersion: z.literal('1'),
  id: PathSegmentSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  stack: PathSegmentSchema,
  nodes: z.array(WorkflowNodeSchema).min(1),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
