# Versioned Hierarchical Task Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backward-compatible, versioned task taxonomy that distinguishes implementation and repair domains, records extracted features, preserves v1 routing metrics, and exposes hierarchy in the existing project dashboard.

**Architecture:** Keep the existing eight-value `TaskKind` as the stable workflow and execution-plane compatibility key. Add taxonomy v2 as an additive `category` path plus `features` on `TaskProfile`; the orchestrator deterministically classifies omitted categories, while workflows may declare one. Metrics use an exact v2 category key with fallback to the existing v1 `modelId + taskKind + role` key, and the current route dashboard groups cards by the category's first level while still showing the full category.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 3, React 19 / Next.js 16, Playwright 1.61, npm workspaces.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-61-task-taxonomy` on branch `agent/issue-61-task-taxonomy`, based on `origin/main` at `d0683b03e05402265fffefe387ac586d13022f3b`.
- Do not change `TaskKindSchema` or the `AgentExecutionRequestSchema.taskKind` wire field; the active issue #45 execution protocol must remain compatible.
- Taxonomy v2 must cover `frontend`, `backend`, `database`, `integration`, and `tests`, plus distinct planning, architecture, review, repair, and verification paths.
- Old workflows that only declare `taskKind` must parse unchanged and be classified deterministically.
- Old metric files keyed as `modelId::taskKind::role` must remain readable and usable as routing fallback data.
- Use no new dependency or speculative abstraction; reuse Zod, Vitest, React, and existing repository patterns.
- Follow TDD for every behavior change: write one focused failing test, verify the expected failure, add the minimum implementation, and verify green before committing.
- `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check` must pass before PR publication.
- The PR must link `Closes #61` and document observable evidence plus security, migration, and rollback impact.

---

### Task 1: Add the versioned taxonomy contract without changing `TaskKind`

**Files:**

- Create: `packages/contracts/src/task-taxonomy.ts`
- Create: `packages/contracts/src/task-taxonomy.test.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/workflow.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: existing `TaskKind` / `TaskKindSchema` from `packages/contracts/src/primitives.ts`.
- Produces: `CURRENT_TASK_TAXONOMY_VERSION`, `TaskTaxonomyVersionSchema`, `TaskFeatureSchema`, `TaskCategorySchema`, `legacyTaskCategory(taskKind)`, and `taskCategoryLevels(category)`; `TaskProfile` outputs required `taxonomyVersion`, `category`, and `features`; `AgentStep.profile.category` is optional.

- [ ] **Step 1: Write the failing taxonomy contract tests**

Create `packages/contracts/src/task-taxonomy.test.ts` with focused assertions that:

```ts
import { describe, expect, it } from 'vitest';
import { TaskProfileSchema } from './model.js';
import {
  CURRENT_TASK_TAXONOMY_VERSION,
  TaskCategorySchema,
  taskCategoryLevels,
} from './task-taxonomy.js';

describe('task taxonomy', () => {
  it('covers the required domains and review/repair families', () => {
    expect(CURRENT_TASK_TAXONOMY_VERSION).toBe('2');
    expect(TaskCategorySchema.options).toEqual(
      expect.arrayContaining([
        'implementation/frontend',
        'implementation/backend',
        'implementation/database',
        'implementation/integration',
        'implementation/tests',
        'repair/frontend',
        'repair/backend',
        'repair/database',
        'repair/integration',
        'repair/tests',
        'review/plan',
        'review/architecture',
        'review/code',
      ]),
    );
  });

  it('normalizes a legacy profile as taxonomy v1', () => {
    const profile = TaskProfileSchema.parse({
      role: 'developer',
      taskKind: 'implementation',
      complexity: 4,
      risk: 4,
      estimatedContextTokens: 20_000,
      estimatedOutputTokens: 8_000,
      mutatesWorkspace: true,
      priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
      preferredTags: ['coding'],
    });

    expect(profile).toMatchObject({
      taxonomyVersion: '1',
      category: 'implementation/general',
      features: [],
    });
  });

  it('returns every hierarchy level without dropping the leaf', () => {
    expect(taskCategoryLevels('repair/database')).toEqual(['repair', 'repair/database']);
  });
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npx vitest run packages/contracts/src/task-taxonomy.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `task-taxonomy.js` and the new `TaskProfile` fields do not exist.

- [ ] **Step 3: Add the minimum taxonomy schemas and legacy mapping**

Create `packages/contracts/src/task-taxonomy.ts` with taxonomy versions `'1' | '2'`, features `frontend | backend | database | integration | tests`, and these accepted category paths:

```ts
export const TaskCategorySchema = z.enum([
  'planning',
  'architecture',
  'implementation/general',
  'implementation/frontend',
  'implementation/backend',
  'implementation/database',
  'implementation/integration',
  'implementation/tests',
  'review/plan',
  'review/architecture',
  'review/code',
  'repair/general',
  'repair/frontend',
  'repair/backend',
  'repair/database',
  'repair/integration',
  'repair/tests',
  'verification/tests',
]);
```

Implement `legacyTaskCategory()` as an exhaustive `switch` over all eight `TaskKind` values, and implement `taskCategoryLevels()` with `category.split('/')` plus prefix joins.

- [ ] **Step 4: Normalize old `TaskProfile` values and accept workflow declarations**

In `packages/contracts/src/model.ts`, preprocess legacy profile objects before the existing object schema: when `taxonomyVersion`, `category`, or `features` is absent, fill `'1'`, `legacyTaskCategory(taskKind)`, and `[]` respectively. Add required `taxonomyVersion`, `category`, and `features` fields to the parsed schema.

In `packages/contracts/src/workflow.ts`, add `category: TaskCategorySchema.optional()` inside `AgentStepSchema.profile`. Export the new taxonomy module from `packages/contracts/src/index.ts`.

- [ ] **Step 5: Verify Task 1 GREEN**

Run: `npx vitest run packages/contracts/src/task-taxonomy.test.ts packages/contracts/src/run.test.ts packages/persistence/src/workflow-repository.test.ts --pool=threads --maxWorkers=1`

Expected: all selected tests PASS, including legacy route and workflow parsing.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/contracts/src/task-taxonomy.ts packages/contracts/src/task-taxonomy.test.ts packages/contracts/src/model.ts packages/contracts/src/workflow.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add versioned task taxonomy"
```

### Task 2: Classify omitted workflow categories and record extracted features

**Files:**

- Create: `packages/orchestrator/src/task-profiler.test.ts`
- Modify: `packages/orchestrator/src/task-profiler.ts`

**Interfaces:**

- Consumes: Task 1's `CURRENT_TASK_TAXONOMY_VERSION`, `TaskCategory`, and `TaskFeature` contracts plus optional `AgentStep.profile.category`.
- Produces: every newly built `TaskProfile` has `taxonomyVersion: '2'`, a declared or classified `category`, and all matching `features` extracted from step instructions, harness text, artifact content, and harness tags.

- [ ] **Step 1: Write failing profiler tests for declared and classified categories**

Create `packages/orchestrator/src/task-profiler.test.ts` with a minimal `implementation` step and empty harness/artifacts. Assert:

```ts
expect(
  buildTaskProfile({
    step: { ...step, profile: { category: 'implementation/frontend' } },
    harness,
    artifacts: [],
  }),
).toMatchObject({
  taxonomyVersion: '2',
  category: 'implementation/frontend',
});

expect(
  buildTaskProfile({
    step: { ...step, instructions: 'Add a PostgreSQL migration and Playwright tests' },
    harness,
    artifacts: [],
  }),
).toMatchObject({
  taxonomyVersion: '2',
  category: 'implementation/database',
  features: ['database', 'tests'],
});
```

Also assert a repair step mentioning a webhook classifies as `repair/integration` and an ordinary legacy implementation step falls back to `implementation/general`.

- [ ] **Step 2: Run the profiler test and verify RED**

Run: `npx vitest run packages/orchestrator/src/task-profiler.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because `buildTaskProfile()` does not return taxonomy fields.

- [ ] **Step 3: Implement deterministic extraction and category selection**

In `packages/orchestrator/src/task-profiler.ts`, use one ordered rule table with case-insensitive word patterns:

```ts
const FEATURE_RULES: ReadonlyArray<readonly [TaskFeature, RegExp]> = [
  ['database', /\b(database|postgres(?:ql)?|sql|supabase|migration|schema)\b/i],
  ['frontend', /\b(frontend|ui|ux|react|next(?:\.js)?|css|component|browser)\b/i],
  ['backend', /\b(backend|server|endpoint|fastify|service)\b/i],
  ['integration', /\b(integration|webhook|provider|external api)\b/i],
  ['tests', /\b(test|tests|testing|spec|vitest|playwright|e2e)\b/i],
];
```

Build the classification text from the same context sources already used for token estimation. Extract every matching feature in rule order. If `step.profile.category` is present, preserve it; otherwise map planning/architecture/review/verification kinds directly and map implementation/repair to their first extracted domain or `general`. Return the current taxonomy version and features in the existing `TaskProfile` object.

- [ ] **Step 4: Verify Task 2 GREEN**

Run: `npx vitest run packages/orchestrator/src/task-profiler.test.ts packages/orchestrator/src/prompt-compiler.test.ts --pool=threads --maxWorkers=1`

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/orchestrator/src/task-profiler.ts packages/orchestrator/src/task-profiler.test.ts
git commit -m "feat(orchestrator): classify task taxonomy profiles"
```

### Task 3: Preserve v1 metrics while learning exact v2 categories

**Files:**

- Create: `packages/persistence/src/metrics-repository.test.ts`
- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/metrics-repository.ts`
- Modify: `packages/model-router/src/score-router.ts`
- Modify: `packages/model-router/src/score-router.test.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`

**Interfaces:**

- Consumes: `TaskProfile.taxonomyVersion` and `TaskProfile.category` from Tasks 1-2.
- Produces: `ModelMetric` records `taxonomyVersion` and `category`; `MetricsRepository.get(modelId, taskKind, role, category?)` checks exact v2 data first and the unchanged v1 key second; `record` and `recordQuality` accept optional taxonomy fields for compatibility.

- [ ] **Step 1: Write the required failing v1 migration test**

Create `packages/persistence/src/metrics-repository.test.ts`. Seed `<temp>/metrics/models.json` with an old record under `legacy::implementation::developer` that has no taxonomy fields. Assert that:

```ts
const metric = await repository.get(
  'legacy',
  'implementation',
  'developer',
  'implementation/frontend',
);
expect(metric).toMatchObject({
  taxonomyVersion: '1',
  category: 'implementation/general',
  attempts: 3,
  successes: 2,
});
```

Add a second test that records taxonomy v2 `implementation/frontend`, reads it back preferentially for that category, and still returns the original v1 record for `implementation/backend`.

- [ ] **Step 2: Run the persistence test and verify RED**

Run: `npx vitest run packages/persistence/src/metrics-repository.test.ts --pool=threads --maxWorkers=1`

Expected: FAIL because the repository has no category lookup and does not parse legacy records through `ModelMetricSchema`.

- [ ] **Step 3: Add metric normalization and exact-category keys**

In `packages/contracts/src/model.ts`, normalize absent metric taxonomy fields exactly like legacy profiles: taxonomy version `'1'`, `legacyTaskCategory(taskKind)`, and no feature field. Add `taxonomyVersion` and `category` to `ModelMetricSchema`.

In `packages/domain/src/ports.ts`, add optional taxonomy arguments without breaking existing test doubles:

```ts
get(modelId: string, taskKind: TaskKind, role: AgentRole, category?: TaskCategory): Promise<ModelMetric | null>;
```

Add optional `taxonomyVersion` and `category` to `record` and `recordQuality` inputs.

In `FileMetricsRepository`, parse the complete file through `z.object({ metrics: z.record(z.string(), ModelMetricSchema) })`. Use `modelId::v2::category::role` only when v2 taxonomy data is supplied, preserve `modelId::taskKind::role` as the v1 key, and make category lookup fall back to the v1 key when the exact v2 record is absent.

- [ ] **Step 4: Thread taxonomy through router and orchestrator metrics calls**

Pass `profile.category` from `ScoreBasedModelRouter.route()` to `metrics.get()`. Update the router test double to accept the optional category and add one assertion that the requested category is `implementation/frontend`.

Pass `route.profile.taxonomyVersion` and `route.profile.category` into failed-attempt, successful-attempt, and quality-outcome metric writes. Add `TaskProfile` to `executeCandidate()` rather than reconstructing taxonomy from `TaskKind`.

- [ ] **Step 5: Verify Task 3 GREEN**

Run: `npx vitest run packages/persistence/src/metrics-repository.test.ts packages/model-router/src/score-router.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/failure-injection.test.ts --pool=threads --maxWorkers=1`

Expected: all selected tests PASS; the v1 fixture is returned as fallback and the v2 category is preferred after recording.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/contracts/src/model.ts packages/domain/src/ports.ts packages/persistence/src/metrics-repository.ts packages/persistence/src/metrics-repository.test.ts packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts packages/orchestrator/src/workflow-orchestrator.ts
git commit -m "feat(router): route with versioned category metrics"
```

### Task 4: Group the route dashboard by hierarchy and document migration/rollback

**Files:**

- Modify: `apps/api/e2e/golden-flow.spec.ts`
- Modify: `apps/web/app/project/[id]/page.tsx`
- Create: `docs/adr/0023-versioned-task-taxonomy.md`
- Modify: `docs/MODEL_ROUTING.md`
- Modify: `docs/VALIDATION.md`

**Interfaces:**

- Consumes: normalized `RouteDecision.profile.category`, `taxonomyVersion`, and `features`.
- Produces: the existing model-router dashboard groups route cards under the first category level and each card displays the complete category plus taxonomy version; the ADR defines compatibility, security, migration, and rollback.

- [ ] **Step 1: Add a failing browser assertion for grouped taxonomy detail**

In `seedWorkspaceAndPlan()` in `apps/api/e2e/golden-flow.spec.ts`, create one route using `runtime.router.route()` with a `TaskProfile` whose category is `implementation/frontend`, and persist a harmless JSON artifact carrying that `routeDecision`. In the golden-flow test, after opening the project page, assert that the router panel shows an `implementation` group and the full `implementation/frontend · taxonomy v2` detail.

- [ ] **Step 2: Run E2E and verify RED**

Run: `npm run e2e --workspace @agent-foundry/api`

Expected: FAIL because the dashboard does not render taxonomy group/detail labels.

- [ ] **Step 3: Group route cards without losing leaf detail**

In `apps/web/app/project/[id]/page.tsx`, extend the existing `routes` memo with a second memo that uses a `Map<string, typeof routes>` keyed by `taskCategoryLevels(route.profile.category)[0]`. Render one group per insertion order; put the existing route-card grid inside the group and add this visible detail above each model id:

```tsx
<p className="eyebrow">
  {route.profile.category} · taxonomy v{route.profile.taxonomyVersion}
</p>
```

Render features when non-empty as `features: frontend, tests`. Keep the existing empty-state behavior and all score/fallback detail.

- [ ] **Step 4: Verify dashboard GREEN**

Run: `npm run e2e --workspace @agent-foundry/api`

Expected: the golden-flow test PASSes, including Axe and the new hierarchy/detail assertions.

- [ ] **Step 5: Document the durable decision and operator evidence**

Create `docs/adr/0023-versioned-task-taxonomy.md` covering:

- `TaskKind` remains the v1 compatibility key and execution-plane field.
- Taxonomy v2 adds category paths and extracted features to profiles.
- Workflow-declared categories win; omission uses deterministic classification.
- Metrics prefer exact v2 keys and fall back to retained v1 keys; parsing and the next write normalize legacy records.
- No permissions, secrets, filesystem reach, or network behavior changes.
- Rollback is a code revert: old runtimes continue reading retained v1 keys and ignore v2 keys/profile fields.

Update `docs/MODEL_ROUTING.md` with the new profile fields, category list, classifier behavior, metric key/fallback order, and dashboard hierarchy. Add an issue #61 evidence section to `docs/VALIDATION.md` naming the focused contract, profiler, migration, router, dashboard E2E, and full-gate commands.

- [ ] **Step 6: Run full validation**

Run, in order:

```bash
npm run check
npm run e2e --workspace @agent-foundry/api
npm run doctor
git diff --check
```

Expected: every command exits 0; `npm run check` covers format, lint, architecture, roadmap, typecheck, unit/script tests, and all builds.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/api/e2e/golden-flow.spec.ts apps/web/app/project/'[id]'/page.tsx docs/adr/0023-versioned-task-taxonomy.md docs/MODEL_ROUTING.md docs/VALIDATION.md
git commit -m "feat(web): group routes by task taxonomy"
```

### Task 5: Publish, review for complexity, fix findings, and attach evidence

**Files:**

- Modify only files already in the issue #61 diff when addressing review findings.
- GitHub: create one PR from `agent/issue-61-task-taxonomy` to `main`; comment evidence on issue #61.

**Interfaces:**

- Consumes: verified branch diff from Tasks 1-4.
- Produces: one issue-linked PR, clean final review, pushed fixes, green GitHub checks, and issue evidence.

- [ ] **Step 1: Run a whole-branch correctness/spec review**

Generate a review package from `origin/main...HEAD` and dispatch the final Superpowers code reviewer. Fix every Critical or Important finding with a focused failing test and re-review until approved.

- [ ] **Step 2: Run the requested simplification reviews**

Run `ponytail:ponytail-review` against `origin/main...HEAD`, then run `code-simplifier-v2` only on files in that diff. Apply all safe behavior-preserving findings, record any skipped risky suggestion, and re-run the focused tests covering each change.

- [ ] **Step 3: Re-run the final gates after review fixes**

```bash
npm run check
npm run e2e --workspace @agent-foundry/api
npm run doctor
git diff --check
```

Expected: every command exits 0 after the last code change.

- [ ] **Step 4: Push and create the issue PR**

Push `agent/issue-61-task-taxonomy` and create a ready-for-review PR to `main` with `Closes #61`. The PR body must list the taxonomy contract, deterministic classification, v1 metrics migration/fallback, dashboard grouping, full commands/results, and security/migration/rollback evaluation.

- [ ] **Step 5: Attach evidence and verify live checks**

Comment on issue #61 with the PR link, focused test names, full validation commands/results, and the migration/rollback statement. Wait for all required GitHub checks; inspect and fix any failure, unresolved review thread, or requested change, then push and re-verify until the PR is clean and green.
