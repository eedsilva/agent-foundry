import { z } from 'zod';
import { AgentArtifactSchema } from './agent.js';
import { PathSegmentSchema } from './primitives.js';

/**
 * How a planned task proves its acceptance. Optional for compatibility with
 * task graphs written before #393; new planners should always emit it.
 */
export const TaskAcceptanceModeSchema = z.enum(['deterministic-only', 'browser-visible']);
export type TaskAcceptanceMode = z.infer<typeof TaskAcceptanceModeSchema>;

export const PlanTaskSchema = z
  .object({
    id: PathSegmentSchema,
    title: z.string().min(1),
    dependsOn: z.array(PathSegmentSchema).default([]),
    deliverables: z.array(z.string().min(1)).min(1),
    acceptanceCheck: z.string().min(1),
    acceptanceMode: TaskAcceptanceModeSchema.optional(),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTaskSchema>;

// Loose: the planner also emits prose fields (goal, scope, milestones, …) in the
// same object; only the task graph is contract-enforced.
export const TaskGraphSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    tasks: z.array(PlanTaskSchema).min(1).max(100),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    for (const [index, task] of graph.tasks.entries()) {
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
    for (const [index, task] of graph.tasks.entries()) {
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
    const remainingDeps = new Map(graph.tasks.map((task) => [task.id, new Set(task.dependsOn)]));
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
  });
export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export const TaskGraphArtifactSchema = AgentArtifactSchema.extend({
  data: TaskGraphSchema,
});
export type TaskGraphArtifact = z.infer<typeof TaskGraphArtifactSchema>;

export const TASK_GRAPH_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/task-graph-artifact-v1.json',
  ...z.toJSONSchema(TaskGraphArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    acyclicDependencyGraph: {
      path: 'data.tasks[*].dependsOn',
      enforcedBy: 'TaskGraphArtifactSchema',
      description:
        'Standard JSON Schema cannot express referential integrity; the runtime Zod parse rejects duplicate task ids, dependencies on unknown task ids, and dependency cycles.',
    },
  },
};
