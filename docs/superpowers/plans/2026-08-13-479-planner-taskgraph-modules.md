# Planner and task-graph generation consume app-shape modules (#479) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real planner (`workflows/web-app-v1.yaml`'s `plan` node) emit the app-shape module list on the task graph itself, tag every task with the single module it belongs to, and enforce a 1:1 module-to-task-group mapping at parse time — so `#478`'s app-shape contract actually drives task generation instead of sitting unused.

**Architecture:** `#478` added `ModuleIdSchema`/`AppShapeModuleSchema`/`AppShapeSchema` to `packages/contracts/src/plan.ts` for the *chat* plan-proposal flow only; the real `web-app-v1.yaml` planner step still emits a flat, module-agnostic task graph validated by `GeneratedTaskGraphArtifactSchema`. This plan extends that schema in place — the one the real pipeline actually uses — by adding a required `module: ModuleId` field to each generated task and a required `modules: AppShapeModule[]` list to the graph container, plus a new cross-validation pass (`validateModuleTaskMapping`) that rejects a task naming a module the graph didn't declare and a module no task references. It follows the exact forward-only-versioning shape `#478` used for `acceptanceMode`: optional on the historical read schemas (`PlanTaskSchema`, `TaskGraphSchema`) so already-persisted graphs keep parsing, required on the generated/write schemas (`GeneratedPlanTaskSchema`, `GeneratedTaskGraphSchema`). `#478`'s own `AppShapeSchema`/`PlanProposalArtifactSchema` (the chat flow) are untouched beyond reusing the same `AppShapeModuleSchema`. Task-graph *execution* (`task-graph-runner.ts`, `packages/domain/src/task-graph.ts`) stays flat and module-agnostic — epic #470 puts execution/parallelism changes out of scope.

**Tech Stack:** TypeScript, Zod (`packages/contracts`), YAML (workflow definitions), Vitest.

**Spec:** `docs/adr/0059-app-shape-contract-in-plan-artifact.md` (Decision: "The plan artifact declares an app-shape contract... The planner emits it; task-graph generation consumes it, producing per-module tasks that reference proven patterns."); epic `#470`; issue `#479` (this plan's ticket). Structural precedent: `docs/superpowers/plans/2026-08-12-478-app-shape-contract.md`.

## Global Constraints

- Module vocabulary is exactly: `auth`, `dashboard`, `storage`, or `crud:<resource>` (resource matches `[a-zA-Z0-9._-]+`). Reuse the existing `ModuleIdSchema`/`AppShapeModuleSchema` from `#478` — do not redefine the vocabulary. (ADR 0059; issue #478 Outcome.)
- 1:1 module-to-task-group mapping, enforced at parse time in `packages/contracts/src/plan.ts`: every task's `module` must name an entry present in the graph's `modules` list (no invented modules), and every entry in `modules` must be referenced by at least one task (no orphaned modules). A module may own more than one task — "1:1" means each module maps to exactly one task-group (the set of tasks naming it), not that a module owns exactly one task.
- Forward-only versioning (ADR 0056), exactly mirroring the existing `acceptanceMode` precedent: `module`/`modules` are `.optional()` on `PlanTaskSchema`/`TaskGraphSchema` (historical reads keep parsing without them) and required on `GeneratedPlanTaskSchema`/`GeneratedTaskGraphSchema` (new planner output must carry them).
- Out of scope (epic #470 + ADR 0059 Consequences): no new stacks or frameworks, no scaffold-template library, no changes to task-graph *execution* order or parallelism (`packages/orchestrator/src/task-graph-runner.ts`, `packages/domain/src/task-graph.ts` stay untouched — modules are a planning/validation concept only in this plan).
- Do not change `#478`'s chat plan-proposal flow semantics: `AppShapeSchema`, `PlanProposalArtifactSchema`, `PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA`, and the `apps/web` approval-UI module-chip rendering are untouched by this plan.
- A genuine live real-mode LLM run per app shape (the epic's exit evidence) needs cloud campaign infrastructure and API budget this task cannot exercise. Per `#478`'s own precedent, this plan proves the module-mapped graph is valid and planner-producible via schema-enforced fixtures (Task 4) — one static, schema-passing `task-graph.json` per HA-0.1 shape — not a live campaign run. Ruling, not a gap: recorded here so the executing agent does not attempt to spin up a real campaign.
- Any package that parses YAML must declare `"yaml": "^2.8.1"` explicitly in its own `package.json` `dependencies` (repo convention — see `packages/persistence/package.json`) rather than relying on workspace hoisting.
- Run `npx tsc -b` after every task that touches `packages/contracts`, `packages/executors`, or `packages/composition`.
- New test files land in the existing fast Vitest bucket automatically (`packages/contracts/**` is not excluded from `test:unit:fast` in `package.json`) — do not edit the fast/slow partition lists. `packages/executors/src/fake-cli.integration.test.ts` is already in the slow bucket (matches the `**/*.integration.test.ts` exclude in `test:unit:fast` and is explicitly listed in `test:unit:slow`) — Task 2 runs it directly with `npx vitest run <path>`, which is unaffected by the npm-script-level excludes.
- Do not run `packages/composition/src/pipeline-regression.e2e.test.ts` as part of this plan's verification: it requires Docker, a real disposable Supabase stack, `RUN_PIPELINE_REGRESSION_E2E=true`, up to 20 minutes, and explicitly asks to run alone on a machine (see its own header comment). Task 2's `fake-cli.integration.test.ts` round-trip covers the same fixture without any of that cost.

---

### Task 1: Module field and 1:1 module↔task-group validation in the contracts package

**Files:**
- Modify: `packages/contracts/src/plan.ts` (full-file rewrite — the module vocabulary block must move above its new use sites; given below in full)
- Modify: `packages/contracts/src/plan.test.ts` (extend the import block, rewrite one existing test, append a new `describe` block)

**Interfaces:**
- Consumes: `AgentArtifactSchema` (`./agent.js`), `PathSegmentSchema` (`./primitives.js`) — both already imported.
- Produces (for Tasks 2-4): `PlanTask['module']` (optional `ModuleId`), `GeneratedTaskGraphSchema`'s `modules: AppShapeModule[]` (required) and each task's `module: ModuleId` (required). `ModuleIdSchema`, `AppShapeModuleSchema`, `AppShapeModule` type are unchanged in shape and still exported (Task 3's `harness/roles/planner.md` update and Task 4's fixtures reference these names).

- [ ] **Step 1: Write the failing tests**

Open `packages/contracts/src/plan.test.ts`. Change the top import block from:

```ts
import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  TaskGraphArtifactSchema,
  TaskGraphSchema,
  PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA,
  AppShapeSchema,
  PlanProposalArtifactSchema,
} from './plan.js';
```

to:

```ts
import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  GeneratedTaskGraphSchema,
  TaskGraphArtifactSchema,
  TaskGraphSchema,
  PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA,
  AppShapeSchema,
  PlanProposalArtifactSchema,
} from './plan.js';
```

Then find this existing test inside the `'task graph contracts'` describe block:

```ts
  it('requires acceptance modes from new planner output while retaining historical reads', () => {
    expect(() =>
      GeneratedTaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: graph,
      }),
    ).toThrow(/acceptanceMode/);
    expect(
      GeneratedTaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: {
          ...graph,
          tasks: graph.tasks.map((task, index) => ({
            ...task,
            acceptanceMode: index === 0 ? 'deterministic-only' : 'browser-visible',
          })),
        },
      }).data.tasks,
    ).toHaveLength(2);
  });
```

Replace it with (adds the now-required `modules`/`module` fields the old test data lacked):

```ts
  it('requires acceptance modes and a module per task from new planner output while retaining historical reads', () => {
    expect(() =>
      GeneratedTaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: graph,
      }),
    ).toThrow(/acceptanceMode/);
    const parsed = GeneratedTaskGraphArtifactSchema.parse({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned the MVP',
      data: {
        ...graph,
        modules: [{ id: 'crud:issues', acceptanceChannel: 'browser-visible' as const }],
        tasks: graph.tasks.map((task, index) => ({
          ...task,
          acceptanceMode: index === 0 ? ('deterministic-only' as const) : ('browser-visible' as const),
          module: 'crud:issues',
        })),
      },
    });
    expect(parsed.data.tasks).toHaveLength(2);
    expect(parsed.data.tasks.map((task) => task.module)).toEqual(['crud:issues', 'crud:issues']);
  });
```

Now append this new `describe` block right after the closing `});` of the `'task graph contracts'` describe block (before the `'app-shape contract (#478)'` block):

```ts

describe('module-to-task-group mapping (#479)', () => {
  const shapedGraph = {
    schemaVersion: '1' as const,
    modules: [
      { id: 'auth', acceptanceChannel: 'browser-visible' as const },
      { id: 'crud:issues', acceptanceChannel: 'browser-visible' as const },
    ],
    tasks: [
      {
        id: 'T1',
        title: 'Auth and protected shell',
        deliverables: ['apps/web/middleware.ts'],
        acceptanceCheck: 'Signed-out access redirects to sign-in',
        acceptanceMode: 'browser-visible' as const,
        module: 'auth',
      },
      {
        id: 'T2',
        title: 'List issues in the UI',
        dependsOn: ['T1'],
        deliverables: ['apps/web/app/issues/page.tsx'],
        acceptanceCheck: 'Visiting /issues renders the seeded issue titles',
        acceptanceMode: 'browser-visible' as const,
        module: 'crud:issues',
      },
    ],
  };

  it('accepts a graph whose modules map 1:1 onto task groups', () => {
    const parsed = GeneratedTaskGraphSchema.parse(shapedGraph);
    expect(parsed.modules.map((module) => module.id)).toEqual(['auth', 'crud:issues']);
    expect(parsed.tasks.map((task) => task.module)).toEqual(['auth', 'crud:issues']);
  });

  it('rejects a task referencing a module outside the modules list', () => {
    expect(() =>
      GeneratedTaskGraphSchema.parse({
        ...shapedGraph,
        tasks: [{ ...shapedGraph.tasks[0], module: 'dashboard' }, shapedGraph.tasks[1]],
      }),
    ).toThrow(/references unknown module dashboard/);
  });

  it('rejects a module with no tasks referencing it', () => {
    expect(() =>
      GeneratedTaskGraphSchema.parse({
        ...shapedGraph,
        modules: [
          ...shapedGraph.modules,
          { id: 'storage', acceptanceChannel: 'deterministic-only' as const },
        ],
      }),
    ).toThrow(/Module storage has no tasks/);
  });

  it('rejects a duplicate module id in the modules list', () => {
    expect(() =>
      GeneratedTaskGraphSchema.parse({
        ...shapedGraph,
        modules: [shapedGraph.modules[0], shapedGraph.modules[0]],
        tasks: [
          { ...shapedGraph.tasks[0], module: 'auth' },
          { ...shapedGraph.tasks[1], module: 'auth' },
        ],
      }),
    ).toThrow(/Duplicate module id auth/);
  });

  it('lets two tasks share one module (a task-group larger than one task)', () => {
    const parsed = GeneratedTaskGraphSchema.parse({
      ...shapedGraph,
      modules: [shapedGraph.modules[1]],
      tasks: [
        { ...shapedGraph.tasks[0], module: 'crud:issues', dependsOn: [] },
        shapedGraph.tasks[1],
      ],
    });
    expect(parsed.tasks.every((task) => task.module === 'crud:issues')).toBe(true);
  });

  it('keeps historical graphs without a modules list readable and unvalidated for module mapping', () => {
    expect(TaskGraphSchema.parse(graph).modules).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/contracts/src/plan.test.ts`
Expected: FAIL — `GeneratedTaskGraphSchema` is not exported from `./plan.js`; the rewritten and new tests reference a `module` field and `modules` list that don't exist yet.

- [ ] **Step 3: Implement the schema**

Replace the entire contents of `packages/contracts/src/plan.ts` with:

```ts
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
export const GeneratedTaskGraphSchema = createTaskGraphSchema(GeneratedPlanTaskSchema, MODULE_LIST_SCHEMA);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/contracts/src/plan.test.ts`
Expected: PASS, all tests including the new `module-to-task-group mapping (#479)` block and the rewritten acceptance-modes test.

Run: `npx vitest run packages/contracts/src/app-shape-fixtures.test.ts`
Expected: PASS unchanged — `AppShapeSchema`'s behavior did not change.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/plan.ts packages/contracts/src/plan.test.ts
git commit -m "feat(479): require a module per task and validate 1:1 module-to-task-group mapping"
```

---

### Task 2: Fix task-graph fixtures broken by the tightened schema

Task 1's `GeneratedTaskGraphSchema` now requires `modules`/`module` wherever a
"planner just emitted this" task graph is validated. Six other files construct
that exact shape as hardcoded test fixtures and will start failing the moment
Task 1 lands, independent of anything Task 3/4 touch. This task repairs all of
them in one batched dispatch (same kind of edit, repeated per file — see
`superpowers:subagent-driven-development`'s "batch small same-shape work").

**Files:**
- Modify: `packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs`
- Modify: `packages/executors/src/fake-cli.integration.test.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts`
- Modify: `packages/orchestrator/src/validation-evidence.test.ts`
- Modify: `apps/api/src/validation-evidence.test.ts`
- Modify: `packages/orchestrator/src/validation-campaign.integration.test.ts`
- Modify: `packages/composition/src/task-execution.integration.test.ts`

**Interfaces:**
- Consumes: `GeneratedTaskGraphArtifactSchema`/`GeneratedTaskGraphSchema` from `@agent-foundry/contracts` (produced by Task 1) — every file below feeds a task-graph-shaped object through `workflow-orchestrator.ts`'s `GeneratedTaskGraphArtifactSchema.safeParse(result.output)` call (line ~3408), either directly (as a mocked `plan.current` artifact / agent output) or via the fake CLI subprocess.
- Produces: nothing consumed by later tasks — this task only repairs regressions Task 1 introduced in fixtures that predate the module field.

This task depends on Task 1 (the schema must already require `module`/`modules` for the failures below to exist). Do not start it before Task 1 is complete.

- [ ] **Step 1: Extend the existing round-trip test to assert schema validity**

Open `packages/executors/src/fake-cli.integration.test.ts`. Change the import block from:

```ts
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  type AgentExecutionRequest,
} from '@agent-foundry/contracts';
```

to:

```ts
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  type AgentExecutionRequest,
} from '@agent-foundry/contracts';
```

Then find the existing test `'round-trips a planning step through the fake codex CLI into a task-graph artifact'` and change its body from:

```ts
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: '1',
      status: 'completed',
      // The 'Fake' marker proves the fake CLI answered — never a real
      // provider CLI that happened to be on PATH.
      summary: expect.stringContaining('Fake'),
      data: { schemaVersion: '1', tasks: expect.any(Array) },
    });
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });
```

to:

```ts
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: '1',
      status: 'completed',
      // The 'Fake' marker proves the fake CLI answered — never a real
      // provider CLI that happened to be on PATH.
      summary: expect.stringContaining('Fake'),
      data: { schemaVersion: '1', tasks: expect.any(Array) },
    });
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
    // The fake CLI's task-graph fixture must satisfy the same schema the
    // real planner's output is validated against (#479) — every task
    // carries its module, and the graph carries the module list.
    const parsed = GeneratedTaskGraphArtifactSchema.parse(result.output);
    expect(parsed.data.modules.length).toBeGreaterThan(0);
    expect(parsed.data.tasks.every((task) => typeof task.module === 'string')).toBe(true);
  });
```

- [ ] **Step 2: Run the affected tests to confirm the regression**

Run each of these (all currently pass on `main`; Task 1 alone breaks them):

- `npx vitest run packages/executors/src/fake-cli.integration.test.ts -t "round-trips a planning step"` — FAIL, the new assertion from Step 1 throws (missing `modules`/`module`).
- `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts` — FAIL, tests using `GENERATED_GRAPH`/`BROWSER_GRAPH` as a mocked plan step's output now get `Step plan must emit a task graph in data; output failed validation`.
- `npx vitest run packages/orchestrator/src/validation-evidence.test.ts` — FAIL, same validation error for the `plan.current` fixture.
- `npx vitest run apps/api/src/validation-evidence.test.ts` — FAIL, same validation error.
- `npx vitest run packages/orchestrator/src/validation-campaign.integration.test.ts` — FAIL, same validation error for `taskRetryPlan`.
- `npx vitest run packages/composition/src/task-execution.integration.test.ts` — FAIL, same validation error for the `TaskGraphExecutor`-synthesized plan output.

- [ ] **Step 3: Fix all six fixtures**

Open `packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs`. Find this block inside `buildArtifact`:

```js
      : identity.outputSchemaId === TASK_GRAPH_SCHEMA_ID
        ? {
            schemaVersion: '1',
            goal: `${label} plan for ${identity.stepId}`,
            tasks: [
              {
                id: 'T1',
                title: 'Create the project skeleton',
                dependsOn: [],
                deliverables: ['package.json', 'src/index.js'],
                acceptanceCheck: 'npm test passes in the generated workspace',
                acceptanceMode: 'deterministic-only',
              },
              {
                id: 'T2',
                title: 'Implement the core flow',
                dependsOn: ['T1'],
                deliverables: ['src/index.js'],
                acceptanceCheck: 'createProject queues a valid project',
                acceptanceMode: t2AcceptanceMode,
              },
            ],
          }
```

Replace it with (adds the module list and tags both tasks with the one module they belong to — #479's 1:1 mapping allows a module to own more than one task):

```js
      : identity.outputSchemaId === TASK_GRAPH_SCHEMA_ID
        ? {
            schemaVersion: '1',
            goal: `${label} plan for ${identity.stepId}`,
            modules: [{ id: 'crud:project', acceptanceChannel: 'deterministic-only' }],
            tasks: [
              {
                id: 'T1',
                title: 'Create the project skeleton',
                dependsOn: [],
                deliverables: ['package.json', 'src/index.js'],
                acceptanceCheck: 'npm test passes in the generated workspace',
                acceptanceMode: 'deterministic-only',
                module: 'crud:project',
              },
              {
                id: 'T2',
                title: 'Implement the core flow',
                dependsOn: ['T1'],
                deliverables: ['src/index.js'],
                acceptanceCheck: 'createProject queues a valid project',
                acceptanceMode: t2AcceptanceMode,
                module: 'crud:project',
              },
            ],
          }
```

Open `packages/orchestrator/src/workflow-orchestrator.test.ts`. Find:

```ts
const GENERATED_GRAPH = {
  ...VALID_GRAPH,
  tasks: VALID_GRAPH.tasks.map((task) => ({ ...task, acceptanceMode: 'deterministic-only' })),
};

const BROWSER_GRAPH = {
  ...VALID_GRAPH,
  tasks: VALID_GRAPH.tasks.map((task) => ({ ...task, acceptanceMode: 'browser-visible' })),
};
```

Replace it with (one shared module id covers both — every downstream usage of `GENERATED_GRAPH`/`BROWSER_GRAPH` inherits the fix):

```ts
const GENERATED_GRAPH = {
  ...VALID_GRAPH,
  modules: [{ id: 'crud:work', acceptanceChannel: 'deterministic-only' as const }],
  tasks: VALID_GRAPH.tasks.map((task) => ({
    ...task,
    acceptanceMode: 'deterministic-only' as const,
    module: 'crud:work',
  })),
};

const BROWSER_GRAPH = {
  ...VALID_GRAPH,
  modules: [{ id: 'crud:work', acceptanceChannel: 'browser-visible' as const }],
  tasks: VALID_GRAPH.tasks.map((task) => ({
    ...task,
    acceptanceMode: 'browser-visible' as const,
    module: 'crud:work',
  })),
};
```

Open `packages/orchestrator/src/validation-evidence.test.ts`. Find the `plan.current` fixture branch:

```ts
          : name === 'plan.current'
            ? {
                schemaVersion: '1' as const,
                status: 'completed' as const,
                summary: 'Three-task TODO plan.',
                data: {
                  schemaVersion: '1' as const,
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                    },
                    ...(options.fourthTask
                      ? [
                          {
                            id: 'public-middleware',
                            title: 'Exclude public routes from authentication middleware',
                            dependsOn: [],
                            deliverables: ['public route middleware exclusion'],
                            acceptanceCheck: 'Unauthenticated requests reach public routes.',
                            acceptanceMode: 'deterministic-only' as const,
                          },
                        ]
                      : []),
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
```

Replace it with (the three base tasks share the `crud:todos` module; the conditional fourth task is auth middleware, so it gets its own `auth` module — added to `modules` only when `options.fourthTask` is set, keeping the 1:1 mapping intact in both cases):

```ts
          : name === 'plan.current'
            ? {
                schemaVersion: '1' as const,
                status: 'completed' as const,
                summary: 'Three-task TODO plan.',
                data: {
                  schemaVersion: '1' as const,
                  modules: [
                    { id: 'crud:todos', acceptanceChannel: 'browser-visible' as const },
                    ...(options.fourthTask
                      ? [{ id: 'auth', acceptanceChannel: 'deterministic-only' as const }]
                      : []),
                  ],
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                      module: 'crud:todos',
                    },
                    ...(options.fourthTask
                      ? [
                          {
                            id: 'public-middleware',
                            title: 'Exclude public routes from authentication middleware',
                            dependsOn: [],
                            deliverables: ['public route middleware exclusion'],
                            acceptanceCheck: 'Unauthenticated requests reach public routes.',
                            acceptanceMode: 'deterministic-only' as const,
                            module: 'auth',
                          },
                        ]
                      : []),
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
```

Open `apps/api/src/validation-evidence.test.ts`. Find the equivalent (simpler — no `fourthTask` branch) `plan.current` fixture branch:

```ts
          : name === 'plan.current'
            ? {
                schemaVersion: '1' as const,
                status: 'completed' as const,
                summary: 'Three-task TODO plan.',
                data: {
                  schemaVersion: '1' as const,
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                    },
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
            : { approved: true };
```

Replace it with:

```ts
          : name === 'plan.current'
            ? {
                schemaVersion: '1' as const,
                status: 'completed' as const,
                summary: 'Three-task TODO plan.',
                data: {
                  schemaVersion: '1' as const,
                  modules: [{ id: 'crud:todos', acceptanceChannel: 'browser-visible' as const }],
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                      module: 'crud:todos',
                    },
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
            : { approved: true };
```

Open `packages/orchestrator/src/validation-campaign.integration.test.ts`. Find:

```ts
const taskRetryPlan: AgentArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Planned two dependent tasks.',
  data: {
    schemaVersion: '1',
    goal: 'Ship the TODO slice',
    tasks: [
      {
        id: 'T1',
        title: 'Persist todos',
        dependsOn: [],
        deliverables: ['src/db.ts'],
        acceptanceCheck: 'Rows persist',
        acceptanceMode: 'deterministic-only',
      },
      {
        id: 'T2',
        title: 'List todos',
        dependsOn: ['T1'],
        deliverables: ['src/list.ts'],
        acceptanceCheck: 'The list returns the stored rows',
        acceptanceMode: 'deterministic-only',
      },
    ],
  },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};
```

Replace it with:

```ts
const taskRetryPlan: AgentArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Planned two dependent tasks.',
  data: {
    schemaVersion: '1',
    goal: 'Ship the TODO slice',
    modules: [{ id: 'crud:todos', acceptanceChannel: 'deterministic-only' }],
    tasks: [
      {
        id: 'T1',
        title: 'Persist todos',
        dependsOn: [],
        deliverables: ['src/db.ts'],
        acceptanceCheck: 'Rows persist',
        acceptanceMode: 'deterministic-only',
        module: 'crud:todos',
      },
      {
        id: 'T2',
        title: 'List todos',
        dependsOn: ['T1'],
        deliverables: ['src/list.ts'],
        acceptanceCheck: 'The list returns the stored rows',
        acceptanceMode: 'deterministic-only',
        module: 'crud:todos',
      },
    ],
  },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};
```

Open `packages/composition/src/task-execution.integration.test.ts`. Find:

```ts
function task(
  id: string,
  dependsOn: string[] = [],
  acceptanceMode?: PlanTask['acceptanceMode'],
): PlanTask {
  return {
    id,
    title: `${id} work`,
    dependsOn,
    deliverables: [`src/${id}.ts`],
    acceptanceCheck: `${id} behaves`,
    ...(acceptanceMode ? { acceptanceMode } : {}),
  };
}
```

Replace it with (every task in this file shares one module, so the 1:1 mapping holds regardless of how many tasks a given test constructs):

```ts
function task(
  id: string,
  dependsOn: string[] = [],
  acceptanceMode?: PlanTask['acceptanceMode'],
): PlanTask {
  return {
    id,
    title: `${id} work`,
    dependsOn,
    deliverables: [`src/${id}.ts`],
    acceptanceCheck: `${id} behaves`,
    module: 'crud:work',
    ...(acceptanceMode ? { acceptanceMode } : {}),
  };
}
```

Then, in the same file, find the `TaskGraphExecutor.execute` method's `output` construction:

```ts
    const output = {
      ...result.output,
      data: {
        schemaVersion: '1' as const,
        goal: 'Fixture plan',
        tasks:
          request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
            ? this.options.tasks.map((task) => ({
                ...task,
                acceptanceMode: task.acceptanceMode ?? 'deterministic-only',
              }))
            : this.options.tasks,
      },
    };
```

Replace it with:

```ts
    const output = {
      ...result.output,
      data: {
        schemaVersion: '1' as const,
        goal: 'Fixture plan',
        ...(request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
          ? { modules: [{ id: 'crud:work', acceptanceChannel: 'deterministic-only' as const }] }
          : {}),
        tasks:
          request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
            ? this.options.tasks.map((task) => ({
                ...task,
                acceptanceMode: task.acceptanceMode ?? 'deterministic-only',
                module: task.module ?? 'crud:work',
              }))
            : this.options.tasks,
      },
    };
```

- [ ] **Step 4: Run all six tests to verify they pass**

Run each of the six commands from Step 2 again.
Expected: PASS, all of them.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs packages/executors/src/fake-cli.integration.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/validation-evidence.test.ts apps/api/src/validation-evidence.test.ts packages/orchestrator/src/validation-campaign.integration.test.ts packages/composition/src/task-execution.integration.test.ts
git commit -m "fix(479): carry a module list through every hardcoded task-graph fixture"
```

---

### Task 3: Wire the module contract into the real planner prompt

**Files:**
- Modify: `workflows/web-app-v1.yaml`
- Modify: `harness/roles/planner.md`
- Modify: `packages/contracts/package.json`
- Create: `packages/contracts/src/workflow-fixtures.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinitionSchema` from `./workflow.js` (already exported, unmodified by this plan).
- Produces: nothing consumed by later tasks — this task's only output is the prompt text the real planner reads at execution time, verified by the new fixture test.

This task does not depend on Task 1 or 2 code-wise (it only edits prose), but do it after them so the schema and the fake-CLI fixture are already consistent with what the prompt now asks the planner to emit.

- [ ] **Step 1: Write the failing test**

Open `packages/contracts/package.json`. Change the `dependencies` block from:

```json
  "dependencies": {
    "zod": "^4.1.12"
  }
```

to:

```json
  "dependencies": {
    "yaml": "^2.8.1",
    "zod": "^4.1.12"
  }
```

Create `packages/contracts/src/workflow-fixtures.test.ts` with this exact content:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './workflow.js';

describe('web-app-v1 planner prompt carries the app-shape module contract (#479)', () => {
  it('stays a valid workflow definition and tells the planner to emit modules', async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, '../../../workflows/web-app-v1.yaml'),
      'utf8',
    );
    const definition = WorkflowDefinitionSchema.parse(parse(raw));
    const planNode = definition.nodes.find((node) => node.id === 'plan');
    if (!planNode || planNode.type !== 'agent') {
      throw new Error('expected an agent node named plan');
    }
    expect(planNode.instructions).toMatch(/app-shape/i);
    expect(planNode.instructions).toMatch(/\bmodule\b/i);
  });

  it('documents the modules field and per-task module id in the planner role prompt', async () => {
    const role = await readFile(
      resolve(import.meta.dirname, '../../../harness/roles/planner.md'),
      'utf8',
    );
    expect(role).toMatch(/`modules`/);
    expect(role).toMatch(/`module`/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/workflow-fixtures.test.ts`
Expected: FAIL — the current `plan` node instructions and `harness/roles/planner.md` mention neither "app-shape" nor a `modules`/`module` field.

- [ ] **Step 3: Wire the prompts**

Open `workflows/web-app-v1.yaml`. Find the `plan` node's `instructions:` block:

```yaml
    instructions: >-
      Analyze the PRD, identify missing or contradictory requirements, define scope boundaries,
      user journeys, acceptance criteria, dependencies, milestones, and a dependency-aware task graph.
      Every task must include acceptanceMode: deterministic-only or browser-visible. Use deterministic-only
      for migrations, configuration, refactors, and backend work whose acceptance is fully covered by
      generated-app checks. Use browser-visible only when a user-visible journey, rendered state,
      navigation, or denial must be asserted in the running app. Never infer the mode from free-text at
      execution time. Optimize for a small shippable first version rather than an imaginary perfect platform.
```

Replace it with:

```yaml
    instructions: >-
      Analyze the PRD, identify missing or contradictory requirements, define scope boundaries,
      user journeys, acceptance criteria, dependencies, milestones, and a dependency-aware task graph.
      First declare the app-shape module list: each module is auth, dashboard, storage, or
      crud:<resource>, with an acceptanceChannel of deterministic-only or browser-visible (ADR 0059).
      Then tag every task with the single module id it belongs to — every module must own at least one
      task, and no task may name a module you did not declare. Every task must include acceptanceMode:
      deterministic-only or browser-visible. Use deterministic-only for migrations, configuration,
      refactors, and backend work whose acceptance is fully covered by generated-app checks. Use
      browser-visible only when a user-visible journey, rendered state, navigation, or denial must be
      asserted in the running app. Never infer the mode from free-text at execution time. Optimize for a
      small shippable first version rather than an imaginary perfect platform.
```

Now open `harness/roles/planner.md`. Find:

```markdown
The `data` object should contain:

- `goal`: one-sentence product outcome.
- `scope.in`: explicit in-scope capabilities.
- `scope.out`: explicit exclusions for this version.
- `requirements`: functional and non-functional requirements with stable IDs.
- `milestones`: ordered milestones, each with deliverables and acceptance criteria.
- `schemaVersion`: the literal string `'1'`.
- `tasks`: the machine-executed task graph. Each task is an object with exactly
  `id` (stable, e.g. `T1`), `title`, `dependsOn` (array of task ids), `deliverables`
  (non-empty array of concrete files or capabilities), and `acceptanceCheck` (the
  observable check that proves the task works). Dependencies must reference existing
  task ids and the graph must be acyclic — the runtime rejects the plan otherwise.
- `openQuestions`: only questions that materially block implementation.
```

Replace it with:

```markdown
The `data` object should contain:

- `goal`: one-sentence product outcome.
- `scope.in`: explicit in-scope capabilities.
- `scope.out`: explicit exclusions for this version.
- `requirements`: functional and non-functional requirements with stable IDs.
- `milestones`: ordered milestones, each with deliverables and acceptance criteria.
- `schemaVersion`: the literal string `'1'`.
- `modules`: the app-shape contract (ADR 0059). A non-empty array of objects with
  `id` (`auth`, `dashboard`, `storage`, or `crud:<resource>`) and `acceptanceChannel`
  (`deterministic-only` or `browser-visible`). Vary the app's *shape* through this
  list — never invent a new stack or framework.
- `tasks`: the machine-executed task graph. Each task is an object with exactly
  `id` (stable, e.g. `T1`), `title`, `dependsOn` (array of task ids), `deliverables`
  (non-empty array of concrete files or capabilities), `acceptanceCheck` (the
  observable check that proves the task works), `acceptanceMode`
  (`deterministic-only` or `browser-visible`), and `module` (the single id from
  `modules` this task belongs to). Dependencies must reference existing task ids and
  the graph must be acyclic. Every module in `modules` must own at least one task, and
  no task may name a module absent from `modules` — the runtime rejects the plan
  otherwise.
- `openQuestions`: only questions that materially block implementation.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/workflow-fixtures.test.ts`
Expected: PASS, both tests.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add workflows/web-app-v1.yaml harness/roles/planner.md packages/contracts/package.json packages/contracts/src/workflow-fixtures.test.ts
git commit -m "feat(479): tell the real planner to emit app-shape modules and tag every task"
```

---

### Task 4: HA-0.1 module-mapped task-graph fixtures for the three shapes

**Files:**
- Create: `docs/evidence/harness-alignment/crud-heavy/task-graph.json`
- Create: `docs/evidence/harness-alignment/dashboard-heavy/task-graph.json`
- Create: `docs/evidence/harness-alignment/auth-heavy/task-graph.json`
- Create: `packages/contracts/src/task-graph-fixtures.test.ts`

**Interfaces:**
- Consumes: `AppShapeSchema`, `GeneratedTaskGraphSchema` from `./plan.js` (produced by Task 1); the existing `docs/evidence/harness-alignment/{shape}/app-shape.json` fixtures (from `#478`, unmodified).
- Produces: nothing consumed by later tasks — this is the plan's final task, providing the "module-mapped graph" evidence per shape (issue #479 Evidence).

This task depends on Task 1 (needs `GeneratedTaskGraphSchema` to enforce the module vocabulary and the 1:1 mapping). Do not start it before Task 1 is complete.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/task-graph-fixtures.test.ts` with this exact content:

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppShapeSchema, GeneratedTaskGraphSchema } from './plan.js';

async function readShapeFixture(shape: string, file: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/${file}`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

async function expectModuleMappedGraph(shape: string, moduleIds: string[]) {
  const appShape = AppShapeSchema.parse(await readShapeFixture(shape, 'app-shape.json'));
  const graph = GeneratedTaskGraphSchema.parse(await readShapeFixture(shape, 'task-graph.json'));
  expect(appShape.modules.map((module) => module.id)).toEqual(moduleIds);
  expect(graph.modules.map((module) => module.id)).toEqual(moduleIds);
  const referencedModules = new Set(graph.tasks.map((task) => task.module));
  expect([...referencedModules].sort()).toEqual([...moduleIds].sort());
}

describe('HA-0.1 task-graph fixtures map 1:1 onto app-shape modules (#479)', () => {
  it('validates the crud-heavy shape task graph', async () => {
    await expectModuleMappedGraph('crud-heavy', [
      'auth',
      'crud:categories',
      'crud:items',
      'crud:stock-adjustments',
    ]);
  });

  it('validates the dashboard-heavy shape task graph', async () => {
    await expectModuleMappedGraph('dashboard-heavy', ['auth', 'dashboard', 'crud:sale-events']);
  });

  it('validates the auth-heavy shape task graph', async () => {
    await expectModuleMappedGraph('auth-heavy', ['auth', 'crud:profiles']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/contracts/src/task-graph-fixtures.test.ts`
Expected: FAIL — `ENOENT` reading `docs/evidence/harness-alignment/crud-heavy/task-graph.json` (file does not exist yet).

- [ ] **Step 3: Write the fixtures**

Create `docs/evidence/harness-alignment/crud-heavy/task-graph.json`:

```json
{
  "schemaVersion": "1",
  "goal": "Let a signed-in team track inventory across categories, items, and stock adjustments.",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "crud:categories", "acceptanceChannel": "browser-visible" },
    { "id": "crud:items", "acceptanceChannel": "browser-visible" },
    { "id": "crud:stock-adjustments", "acceptanceChannel": "browser-visible" }
  ],
  "tasks": [
    {
      "id": "T1",
      "title": "Email/password auth and protected app shell",
      "dependsOn": [],
      "deliverables": [
        "apps/web/app/(auth)/sign-in/page.tsx",
        "apps/web/app/(auth)/sign-up/page.tsx",
        "apps/web/middleware.ts"
      ],
      "acceptanceCheck": "Signed-out access to any app route redirects to sign-in; a signed-up user can sign in and reach the app shell.",
      "acceptanceMode": "browser-visible",
      "module": "auth"
    },
    {
      "id": "T2",
      "title": "Category list, create, edit, delete",
      "dependsOn": ["T1"],
      "deliverables": ["apps/web/app/categories/page.tsx", "apps/web/app/categories/actions.ts"],
      "acceptanceCheck": "A signed-in user creates, edits, and deletes a category; deleting a category with items attached shows an inline error and does not delete it.",
      "acceptanceMode": "browser-visible",
      "module": "crud:categories"
    },
    {
      "id": "T3",
      "title": "Item list with filters, create/edit/delete, bulk quantity edit",
      "dependsOn": ["T1", "T2"],
      "deliverables": ["apps/web/app/items/page.tsx", "apps/web/app/items/actions.ts"],
      "acceptanceCheck": "A signed-in user creates an item in a category, filters the list by category and by low-stock, and applies one quantity delta to 2+ selected items in a single bulk action.",
      "acceptanceMode": "browser-visible",
      "module": "crud:items"
    },
    {
      "id": "T4",
      "title": "Stock adjustment log and per-item history view",
      "dependsOn": ["T3"],
      "deliverables": ["apps/web/app/items/[id]/history/page.tsx"],
      "acceptanceCheck": "Adjusting an item's quantity, single or bulk, requires a reason and appends one adjustment row per item; the item's history view lists its adjustments most recent first.",
      "acceptanceMode": "browser-visible",
      "module": "crud:stock-adjustments"
    }
  ]
}
```

Create `docs/evidence/harness-alignment/dashboard-heavy/task-graph.json`:

```json
{
  "schemaVersion": "1",
  "goal": "Let a signed-in user explore seeded sales performance by day, category, and date range.",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "dashboard", "acceptanceChannel": "browser-visible" },
    { "id": "crud:sale-events", "acceptanceChannel": "browser-visible" }
  ],
  "tasks": [
    {
      "id": "T1",
      "title": "Email/password auth and protected app shell",
      "dependsOn": [],
      "deliverables": ["apps/web/app/(auth)/sign-in/page.tsx", "apps/web/middleware.ts"],
      "acceptanceCheck": "Signed-out access to any app route redirects to sign-in; a signed-up user can sign in and reach the dashboard shell.",
      "acceptanceMode": "browser-visible",
      "module": "auth"
    },
    {
      "id": "T2",
      "title": "Sale-event seeding, manual entry, and event list",
      "dependsOn": ["T1"],
      "deliverables": ["apps/web/app/events/page.tsx", "apps/web/app/events/actions.ts"],
      "acceptanceCheck": "A signed-in user seeds ~90 days of sale events across the 5 categories, adds one manual event, and sees it in the paginated event list, most recent first.",
      "acceptanceMode": "browser-visible",
      "module": "crud:sale-events"
    },
    {
      "id": "T3",
      "title": "Date-range filter, totals chart, and top-5-category breakdown",
      "dependsOn": ["T1", "T2"],
      "deliverables": ["apps/web/app/dashboard/page.tsx", "apps/web/app/dashboard/charts.tsx"],
      "acceptanceCheck": "Changing the date-range picker (default last 30 days) re-scopes the totals chart and the top-5-category breakdown, and a manual event added inside the range is reflected after a refresh.",
      "acceptanceMode": "browser-visible",
      "module": "dashboard"
    }
  ]
}
```

Create `docs/evidence/harness-alignment/auth-heavy/task-graph.json`:

```json
{
  "schemaVersion": "1",
  "goal": "Let members manage their own profile and let admins manage the member directory, with RLS enforcing the role boundary.",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "crud:profiles", "acceptanceChannel": "browser-visible" }
  ],
  "tasks": [
    {
      "id": "T1",
      "title": "Auth with member-default sign-up and an admin bootstrap step",
      "dependsOn": [],
      "deliverables": [
        "apps/web/app/(auth)/sign-in/page.tsx",
        "apps/web/app/(auth)/sign-up/page.tsx",
        "scripts/bootstrap-admin.ts"
      ],
      "acceptanceCheck": "A new sign-up defaults to the member role; running the bootstrap step promotes the first signed-up user to admin.",
      "acceptanceMode": "browser-visible",
      "module": "auth"
    },
    {
      "id": "T2",
      "title": "Own-profile edit, admin member directory and detail, role change, RLS",
      "dependsOn": ["T1"],
      "deliverables": [
        "apps/web/app/profile/page.tsx",
        "apps/web/app/members/page.tsx",
        "apps/web/app/members/[id]/page.tsx"
      ],
      "acceptanceCheck": "A member edits their own display name and bio and cannot reach /members; an admin lists members, opens a member's detail, and changes their role; a member's direct database read of another profile is rejected by RLS.",
      "acceptanceMode": "browser-visible",
      "module": "crud:profiles"
    }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/contracts/src/task-graph-fixtures.test.ts`
Expected: PASS, 3/3.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add docs/evidence/harness-alignment/crud-heavy/task-graph.json docs/evidence/harness-alignment/dashboard-heavy/task-graph.json docs/evidence/harness-alignment/auth-heavy/task-graph.json packages/contracts/src/task-graph-fixtures.test.ts
git commit -m "test(479): add HA-0.1 module-mapped task-graph fixtures for the three shapes"
```

---

## Final Verification

After all four tasks:

- [ ] Run `npx tsc -b` from the repo root — no errors.
- [ ] Run `npm run test:unit:fast` — all tests pass, including the four new/edited test files under `packages/contracts/src`.
- [ ] Run `npx vitest run packages/executors/src/fake-cli.integration.test.ts packages/orchestrator/src/validation-campaign.integration.test.ts packages/composition/src/task-execution.integration.test.ts apps/api/src/validation-evidence.test.ts` — passes (slow-bucket files touched by Task 2, none require Docker).
- [ ] Run `npm run check` — the repo's full pre-PR gate passes.
- [ ] Confirm no changes landed outside: `packages/contracts/src/plan.ts`, `packages/contracts/src/plan.test.ts`, `packages/contracts/src/workflow-fixtures.test.ts`, `packages/contracts/src/task-graph-fixtures.test.ts`, `packages/contracts/package.json`, `packages/executors/src/fixtures/fake-cli/fake-cli-core.mjs`, `packages/executors/src/fake-cli.integration.test.ts`, `packages/orchestrator/src/workflow-orchestrator.test.ts`, `packages/orchestrator/src/validation-evidence.test.ts`, `apps/api/src/validation-evidence.test.ts`, `packages/orchestrator/src/validation-campaign.integration.test.ts`, `packages/composition/src/task-execution.integration.test.ts`, `workflows/web-app-v1.yaml`, `harness/roles/planner.md`, `docs/evidence/harness-alignment/{crud-heavy,dashboard-heavy,auth-heavy}/task-graph.json` (`git diff --stat main...HEAD`).
- [ ] `packages/composition/src/pipeline-regression.e2e.test.ts` and a live real-mode LLM run per shape are intentionally not exercised by this plan (see Global Constraints) — do not attempt to run them as part of closing this plan.
