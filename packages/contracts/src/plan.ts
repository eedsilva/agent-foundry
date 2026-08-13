import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';
import { PathSegmentSchema } from './primitives.js';

/** How a planned task proves its acceptance. */
export const TaskAcceptanceModeSchema = z.enum(['deterministic-only', 'browser-visible']);
export type TaskAcceptanceMode = z.infer<typeof TaskAcceptanceModeSchema>;

const APP_SHAPE_MODULE_ID_PATTERN = /^(?:auth|dashboard|storage|crud:[a-zA-Z0-9._-]+)$/;

/** Module vocabulary from ADR 0059: auth, dashboard, storage, or a
 * crud:<resource> variant. Unknown ids are rejected. Expressed as a single
 * regex (not an enum + separate refine) so the published JSON Schema's
 * `pattern` field actually documents the vocabulary for model consumers. */
export const ModuleIdSchema = z.string().regex(APP_SHAPE_MODULE_ID_PATTERN, {
  message: 'Module must be one of auth, dashboard, storage, or crud:<resource>',
});
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const AppShapeModuleSchema = z
  .object({
    id: ModuleIdSchema,
    acceptanceChannel: TaskAcceptanceModeSchema,
  })
  .strict();
export type AppShapeModule = z.infer<typeof AppShapeModuleSchema>;

const MODULE_LIST_SCHEMA = z.array(AppShapeModuleSchema).min(1).max(50);

const planTaskFields = {
  id: PathSegmentSchema,
  title: z.string().min(1),
  dependsOn: z.array(PathSegmentSchema).default([]),
  deliverables: z.array(z.string().min(1)).min(1),
  acceptanceCheck: z.string().min(1),
};

/** Historical task graphs may omit acceptanceMode/module and remain readable. */
export const PlanTaskSchema = z
  .object({
    ...planTaskFields,
    acceptanceMode: TaskAcceptanceModeSchema.optional(),
    module: ModuleIdSchema.optional(),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

const GeneratedPlanTaskSchema = z
  .object({
    ...planTaskFields,
    acceptanceMode: TaskAcceptanceModeSchema,
    module: ModuleIdSchema,
  })
  .strict();

type TaskGraphValidationTask = { id: string; dependsOn: string[] };

/** Flags duplicate `id`s within an array-valued field, returning the set of
 * ids seen so callers needing referential checks (e.g. dependency graphs)
 * don't have to walk the array twice. */
function rejectDuplicateIds(
  items: readonly { id: string }[],
  containerKey: string,
  label: string,
  ctx: z.RefinementCtx,
): Set<string> {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [containerKey, index, 'id'],
        message: `Duplicate ${label} id ${item.id}`,
      });
    }
    seen.add(item.id);
  }
  return seen;
}

function validateTaskGraph(tasks: readonly TaskGraphValidationTask[], ctx: z.RefinementCtx): void {
  const ids = rejectDuplicateIds(tasks, 'tasks', 'task', ctx);
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

type ModuleMappingTask = { id: string; module?: string };
type ModuleMappingModule = { id: string };

/** Cross-checks a task graph's per-task `module` references against its
 * `modules` list (ADR 0059 / #479): every task's module must exist in the
 * list, and every module in the list must be referenced by at least one
 * task — a 1:1 module-to-task-group mapping in both directions. Runs only
 * when a `modules` list is present, so historical graphs without one are
 * unaffected. */
function validateModuleTaskMapping(
  modules: readonly ModuleMappingModule[],
  tasks: readonly ModuleMappingTask[],
  ctx: z.RefinementCtx,
): void {
  const moduleIds = rejectDuplicateIds(modules, 'modules', 'module', ctx);
  const referenced = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    if (task.module === undefined) continue;
    if (!moduleIds.has(task.module)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', index, 'module'],
        message: `Task ${task.id} references unknown module ${task.module}`,
      });
      continue;
    }
    referenced.add(task.module);
  }
  for (const [index, module] of modules.entries()) {
    if (!referenced.has(module.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['modules', index, 'id'],
        message: `Module ${module.id} has no tasks`,
      });
    }
  }
}

function createTaskGraphSchema<T extends z.ZodTypeAny, M extends z.ZodTypeAny>(
  taskSchema: T,
  modulesSchema: M,
) {
  return z
    .looseObject({
      schemaVersion: z.literal('1'),
      modules: modulesSchema,
      tasks: z.array(taskSchema).min(1).max(100),
    })
    .superRefine((graph, ctx) => {
      validateTaskGraph(graph.tasks as TaskGraphValidationTask[], ctx);
      if (Array.isArray(graph.modules)) {
        validateModuleTaskMapping(
          graph.modules as ModuleMappingModule[],
          graph.tasks as ModuleMappingTask[],
          ctx,
        );
      }
    });
}

// Loose: the planner also emits prose fields (goal, scope, milestones, …) in the
// same object; only the task graph is contract-enforced. This read schema keeps
// persisted graphs written before #393, and before #479's module field, compatible.
export const TaskGraphSchema = createTaskGraphSchema(PlanTaskSchema, MODULE_LIST_SCHEMA.optional());
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const TaskGraphArtifactSchema = AgentArtifactSchema.extend({
  data: TaskGraphSchema,
});
export type TaskGraphArtifact = z.infer<typeof TaskGraphArtifactSchema>;

/** Output contract for new planners: every task must declare its acceptance
 * channel and owning module, and the graph must carry the app-shape module
 * list those references resolve against (ADR 0059 / #479). */
export const GeneratedTaskGraphSchema = createTaskGraphSchema(
  GeneratedPlanTaskSchema,
  MODULE_LIST_SCHEMA,
);
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
    moduleTaskMapping: {
      path: 'data.tasks[*].module',
      enforcedBy: 'GeneratedTaskGraphArtifactSchema',
      description:
        'Standard JSON Schema cannot express cross-array referential integrity; the runtime Zod parse rejects a task referencing a module outside data.modules, and a module in data.modules referenced by no task.',
    },
  },
};

// Loose: forward-only versioning per ADR 0056 — future optional fields on the
// app-shape contract must not break parsing of already-persisted plan artifacts.
// Used by the chat plan-proposal flow (#478); the real web-app-v1 planner path
// carries its module list on the task graph itself, above (#479).
export const AppShapeSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    modules: MODULE_LIST_SCHEMA,
  })
  .superRefine((shape, ctx) => {
    rejectDuplicateIds(shape.modules, 'modules', 'module', ctx);
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
        "Standard JSON Schema cannot express cross-item uniqueness; the runtime Zod parse rejects duplicate module ids within one plan. The module id vocabulary itself IS expressed via this schema's regex pattern.",
    },
  },
};
