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

export const ApprovalActionSchema = z.enum(['approve', 'reject', 'request-changes']);
export type ApprovalAction = z.infer<typeof ApprovalActionSchema>;

export const ApprovalTimeoutPolicySchema = z
  .object({
    policy: z.enum(['none', 'auto-approve', 'auto-reject']).default('none'),
    afterMs: z.number().int().positive().optional(),
  })
  .strict()
  .refine((timeout) => timeout.policy === 'none' || timeout.afterMs !== undefined, {
    message: 'afterMs is required when a timeout policy is set',
    path: ['afterMs'],
  });

/**
 * Halts the run at this node until a human decision is persisted. Named
 * `approval-gate` (not `approval`) to avoid confusion with QualityLoopStep's
 * unrelated `approval: ArtifactCondition` field.
 */
const ApprovalGateStepSchema = z
  .object({
    id: PathSegmentSchema,
    type: z.literal('approval-gate'),
    title: z.string().min(1),
    artifact: PathSegmentSchema,
    outputArtifact: PathSegmentSchema,
    actions: z.array(ApprovalActionSchema).min(1).default(['approve', 'reject']),
    onReject: z.enum(['end', 'return-to-step']).default('end'),
    returnToStepId: PathSegmentSchema.optional(),
    repairArtifact: PathSegmentSchema.optional(),
    timeout: ApprovalTimeoutPolicySchema.default({ policy: 'none' }),
  })
  .strict()
  .superRefine((step, ctx) => {
    if (step.onReject === 'return-to-step' && !step.returnToStepId) {
      ctx.addIssue({
        code: 'custom',
        path: ['returnToStepId'],
        message: "onReject: 'return-to-step' requires returnToStepId",
      });
    }
    if (step.actions.includes('request-changes') && (!step.returnToStepId || !step.repairArtifact)) {
      ctx.addIssue({
        code: 'custom',
        path: ['repairArtifact'],
        message: "'request-changes' requires both returnToStepId and repairArtifact",
      });
    }
  });
export type ApprovalGateStep = z.infer<typeof ApprovalGateStepSchema>;

export const WorkflowNodeSchema = z.discriminatedUnion('type', [
  AgentStepSchema,
  VerifyStepSchema,
  QualityLoopStepSchema,
  ApprovalGateStepSchema,
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
