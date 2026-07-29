import { z } from 'zod';
import {
  PathSegmentSchema,
  WorkflowAgentRoleSchema,
  WorkflowTaskKindSchema,
} from './primitives.js';
import { ExecutionSecretRefSchema } from './execution-secret-ref.js';
import { RoutingPrioritiesSchema } from './model.js';
import { isTaskCategoryCompatible, TaskCategorySchema } from './task-taxonomy.js';

export const ArtifactConditionSchema = z.object({
  artifact: PathSegmentSchema,
  path: z.string().min(1),
  equals: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type ArtifactCondition = z.infer<typeof ArtifactConditionSchema>;

const AgentStepSchema = z
  .object({
    id: PathSegmentSchema,
    type: z.literal('agent'),
    role: WorkflowAgentRoleSchema,
    taskKind: WorkflowTaskKindSchema,
    title: z.string().min(1),
    instructions: z.string().min(1),
    inputArtifacts: z.array(PathSegmentSchema).default([]),
    outputArtifact: PathSegmentSchema,
    outputContract: z.literal('task-graph').optional(),
    secretRefs: z.array(ExecutionSecretRefSchema).default([]),
    mutatesWorkspace: z.boolean().default(false),
    harnessTags: z.array(z.string()).default([]),
    profile: z
      .object({
        complexity: z.number().int().min(1).max(5).optional(),
        risk: z.number().int().min(1).max(5).optional(),
        category: TaskCategorySchema.optional(),
        priorities: RoutingPrioritiesSchema.partial().optional(),
        allowedProviders: z.array(z.enum(['codex', 'claude', 'agy'])).optional(),
        preferredTags: z.array(z.string()).optional(),
      })
      .default({}),
    maxAttempts: z.number().int().min(1).max(5).default(2),
  })
  .refine(
    (step) =>
      step.profile.category === undefined ||
      isTaskCategoryCompatible(step.taskKind, step.profile.category),
    { message: 'Category is incompatible with taskKind', path: ['profile', 'category'] },
  );
export type AgentStep = z.infer<typeof AgentStepSchema>;

const VerifyStepSchema = z
  .object({
    id: PathSegmentSchema,
    type: z.literal('verify'),
    title: z.string().min(1),
    outputArtifact: PathSegmentSchema,
    scripts: z.array(z.string()).default(['typecheck', 'lint', 'test', 'build']),
    /**
     * Run before the checks and never gating: a formatter and `lint --fix`
     * repair what a machine can, so the agent is only asked for what it
     * cannot (#324).
     */
    autofixScripts: z.array(z.string()).default([]),
    /**
     * Checks that gate only once the project defines them. A generated app
     * starts without a lint or test script and grows both; naming them here
     * gates on them from the moment they exist, without failing the tasks
     * that come before.
     */
    optionalScripts: z.array(z.string()).default([]),
    includeGitDiffCheck: z.boolean().default(true),
    browserTestPlanArtifact: PathSegmentSchema.optional(),
  })
  .refine(
    (step) =>
      !step.browserTestPlanArtifact ||
      (step.scripts.length === 0 &&
        step.autofixScripts.length === 0 &&
        step.optionalScripts.length === 0 &&
        step.includeGitDiffCheck === false),
    { message: 'Browser verification cannot include workspace checks' },
  );
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

/**
 * Fans out over the task graph an earlier node wrote (#321's `plan.current`),
 * running `implement` once per task in dependency order and committing each
 * task on its own. `quality-loop` cannot express this: its steps are fixed at
 * authoring time, and this list only exists once the run reads the artifact.
 *
 * `implement.maxAttempts` is honoured here — it bounds how many times a single
 * task is attempted before the node fails, and every attempt is a timeline
 * event (see #211, which records the engine ignoring it elsewhere).
 *
 * `verify` and `repair` are the task's deterministic gate (#324): the checks
 * run after the implementation, a red report is what invokes `repair`, and
 * `repair.maxAttempts` bounds how many times it may try before the task fails.
 * They arrive as a pair — a gate with nothing to call is a dead end, and a
 * repairer with nothing to trigger it never runs.
 *
 * `browser` is the task's assertion that the feature actually works (#325):
 * typecheck passing does not mean a user can sign in. `plan` turns the task's
 * acceptance check into a declarative `browser-test.plan`, `check` runs it
 * against the live preview once the deterministic checks are green, and a
 * failed assertion reaches the same bounded `repair`.
 */
const TaskBrowserAssertionSchema = z
  .object({
    /** Turns the task's `acceptanceCheck` into a declarative browser plan. */
    plan: AgentStepSchema,
    /** Runs that plan against the live preview. */
    check: VerifyStepSchema,
  })
  .strict()
  .superRefine((browser, ctx) => {
    if (browser.check.browserTestPlanArtifact !== browser.plan.outputArtifact) {
      ctx.addIssue({
        code: 'custom',
        path: ['check', 'browserTestPlanArtifact'],
        message: 'browser check must read the artifact its plan step writes',
      });
    }
    if (browser.plan.mutatesWorkspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['plan', 'mutatesWorkspace'],
        message: 'browser plan step must not mutate the workspace',
      });
    }
  });
export type TaskBrowserAssertion = z.infer<typeof TaskBrowserAssertionSchema>;

const ForEachTaskStepSchema = z
  .object({
    id: PathSegmentSchema,
    type: z.literal('for-each-task'),
    title: z.string().min(1),
    /** Artifact carrying the `TaskGraph` to walk, e.g. `plan.current`. */
    taskGraphArtifact: PathSegmentSchema,
    implement: AgentStepSchema,
    verify: VerifyStepSchema.optional(),
    repair: AgentStepSchema.optional(),
    browser: TaskBrowserAssertionSchema.optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if (!node.implement.mutatesWorkspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['implement', 'mutatesWorkspace'],
        message: 'for-each-task implement step must set mutatesWorkspace: true',
      });
    }
    if (node.verify && !node.repair) {
      ctx.addIssue({
        code: 'custom',
        path: ['repair'],
        message: 'for-each-task verify requires a repair step to invoke on a failure',
      });
    }
    if (node.repair && !node.verify) {
      ctx.addIssue({
        code: 'custom',
        path: ['verify'],
        message: 'for-each-task repair requires a verify step to trigger it',
      });
    }
    if (node.browser && !node.verify) {
      ctx.addIssue({
        code: 'custom',
        path: ['verify'],
        // The assertion runs against a preview built from code the deterministic
        // checks already passed, and it reuses that gate's repair step.
        message: 'for-each-task browser assertion requires the deterministic gate to run first',
      });
    }
    if (node.repair && !node.repair.mutatesWorkspace) {
      ctx.addIssue({
        code: 'custom',
        path: ['repair', 'mutatesWorkspace'],
        message: 'for-each-task repair step must set mutatesWorkspace: true',
      });
    }
  });
export type ForEachTaskStep = z.infer<typeof ForEachTaskStepSchema>;

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
    if (
      step.actions.includes('request-changes') &&
      (!step.returnToStepId || !step.repairArtifact)
    ) {
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
  ForEachTaskStepSchema,
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
