import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';
import { PathSegmentSchema } from './primitives.js';

/** How a planned task proves its acceptance. */
export const TaskAcceptanceModeSchema = z.enum(['deterministic-only', 'browser-visible']);
export type TaskAcceptanceMode = z.infer<typeof TaskAcceptanceModeSchema>;

const planTaskFields = {
  id: PathSegmentSchema,
  title: z.string().min(1),
  dependsOn: z.array(PathSegmentSchema).default([]),
  deliverables: z.array(z.string().min(1)).min(1),
  acceptanceCheck: z.string().min(1),
};

/** Historical task graphs may omit acceptanceMode and remain readable. */
export const PlanTaskSchema = z
  .object({ ...planTaskFields, acceptanceMode: TaskAcceptanceModeSchema.optional() })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

const GeneratedPlanTaskSchema = z
  .object({ ...planTaskFields, acceptanceMode: TaskAcceptanceModeSchema })
  .strict();

type TaskGraphValidationTask = { id: string; dependsOn: string[] };

function validateTaskGraph(tasks: readonly TaskGraphValidationTask[], ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    if (ids.has(task.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', index, 'id'],
        message: `Duplicate task id ${task.id}`,
      });
    }
    ids.add(task.id);
  }
  let unknownDependency = false;
  for (const [index, task] of tasks.entries()) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        unknownDependency = true;
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'dependsOn'],
          message: `Task ${task.id} depends on unknown task ${dependency}`,
        });
      }
    }
  }
  if (unknownDependency) return;
  // Kahn's algorithm: whatever cannot be topologically ordered is on a cycle.
  const remainingDeps = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, deps] of remainingDeps) {
      if (deps.size > 0) continue;
      remainingDeps.delete(id);
      for (const otherDeps of remainingDeps.values()) otherDeps.delete(id);
      progressed = true;
    }
  }
  if (remainingDeps.size > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['tasks'],
      message: `Dependency cycle among tasks: ${[...remainingDeps.keys()].join(', ')}`,
    });
  }
}

function createTaskGraphSchema<T extends z.ZodTypeAny>(taskSchema: T) {
  return z
    .looseObject({
      schemaVersion: z.literal('1'),
      tasks: z.array(taskSchema).min(1).max(100),
    })
    .superRefine((graph, ctx) => {
      validateTaskGraph(graph.tasks as TaskGraphValidationTask[], ctx);
    });
}

// Loose: the planner also emits prose fields (goal, scope, milestones, …) in the
// same object; only the task graph is contract-enforced. This read schema keeps
// persisted graphs written before #393 compatible.
export const TaskGraphSchema = createTaskGraphSchema(PlanTaskSchema);
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const TaskGraphArtifactSchema = AgentArtifactSchema.extend({
  data: TaskGraphSchema,
});
export type TaskGraphArtifact = z.infer<typeof TaskGraphArtifactSchema>;

/** Output contract for new planners: every task must declare its acceptance channel. */
export const GeneratedTaskGraphSchema = createTaskGraphSchema(GeneratedPlanTaskSchema);
export type GeneratedTaskGraph = z.infer<typeof GeneratedTaskGraphSchema>;

export const GeneratedTaskGraphArtifactSchema = AgentArtifactSchema.extend({
  data: GeneratedTaskGraphSchema,
});
export type GeneratedTaskGraphArtifact = z.infer<typeof GeneratedTaskGraphArtifactSchema>;

export const TASK_GRAPH_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/task-graph-artifact-v1.json',
  ...z.toJSONSchema(GeneratedTaskGraphArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    acyclicDependencyGraph: {
      path: 'data.tasks[*].dependsOn',
      enforcedBy: 'GeneratedTaskGraphArtifactSchema',
      description:
        'Standard JSON Schema cannot express referential integrity; the runtime Zod parse rejects duplicate task ids, dependencies on unknown task ids, and dependency cycles.',
    },
  },
};

const APP_SHAPE_FIXED_MODULE_IDS = ['auth', 'dashboard', 'storage'] as const;
const APP_SHAPE_CRUD_MODULE_ID_PATTERN = /^crud:[a-zA-Z0-9._-]+$/;

/** Module vocabulary from #473's observed-shape defect list: auth, dashboard,
 * storage, or a crud:<resource> variant. Unknown ids are rejected. */
export const ModuleIdSchema = z
  .string()
  .refine(
    (value) =>
      (APP_SHAPE_FIXED_MODULE_IDS as readonly string[]).includes(value) ||
      APP_SHAPE_CRUD_MODULE_ID_PATTERN.test(value),
    {
      message: `Module must be one of ${APP_SHAPE_FIXED_MODULE_IDS.join(', ')}, or crud:<resource>`,
    },
  );
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const AppShapeModuleSchema = z
  .object({
    id: ModuleIdSchema,
    acceptanceChannel: TaskAcceptanceModeSchema,
  })
  .strict();
export type AppShapeModule = z.infer<typeof AppShapeModuleSchema>;

type AppShapeModuleForValidation = { id: string };

function validateAppShapeModules(
  modules: readonly AppShapeModuleForValidation[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (seen.has(module.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['modules', index, 'id'],
        message: `Duplicate module id ${module.id}`,
      });
    }
    seen.add(module.id);
  }
}

// Loose: forward-only versioning per ADR 0056 — future optional fields on the
// app-shape contract must not break parsing of already-persisted plan artifacts.
export const AppShapeSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    modules: z.array(AppShapeModuleSchema).min(1).max(50),
  })
  .superRefine((shape, ctx) => {
    validateAppShapeModules(shape.modules as AppShapeModuleForValidation[], ctx);
  });
export type AppShape = z.infer<typeof AppShapeSchema>;

export const PlanProposalArtifactSchema = AgentArtifactSchema.extend({
  data: AppShapeSchema,
});
export type PlanProposalArtifact = z.infer<typeof PlanProposalArtifactSchema>;

export const PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/plan-proposal-artifact-v1.json',
  ...z.toJSONSchema(PlanProposalArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    moduleVocabulary: {
      path: 'data.modules[*].id',
      enforcedBy: 'PlanProposalArtifactSchema',
      description:
        'Standard JSON Schema cannot express the crud:<resource> templated variant or cross-item uniqueness; the runtime Zod parse rejects module ids outside auth, dashboard, storage, crud:<resource>, and duplicate module ids within one plan.',
    },
  },
};
