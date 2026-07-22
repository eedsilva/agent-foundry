# Issue #62 Production Routing Constraints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining issue #62 audit gap by making quota budgets proportional to observed subscription usage and supplying live provider health to every production model-routing path.

**Architecture:** Keep the existing optional `RouteConstraints` contract and telemetry schemas. Estimate subscription quota from `ModelMetric.quotaUnitsTotal / quotaUnitsKnownCount`, compare it with the smaller of an explicit quota budget and provider-reported remaining units, and preserve unknown values. Both orchestration paths build the existing provider-health map from their executor registry before routing; no new service, schema, dependency, or cumulative budget ledger is introduced.

**Tech Stack:** TypeScript 5.9, Vitest, npm workspaces, existing contracts/domain/model-router/orchestrator/composition packages.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-issue-62-usage-routing` on branch `issue-62-usage-routing`; never commit or push implementation code to `main`.
- Follow strict TDD: add each regression first, run it and observe the expected failure, then write the minimum production change and rerun it green.
- Missing cost, quota, token, rate-limit, or source-quality data remains unknown; never invent zero.
- Preserve the optional `RouteConstraints` public API and behavior when constraints or quota history are absent.
- Use `ModelMetric.quotaUnitsTotal / quotaUnitsKnownCount` only when `quotaUnitsKnownCount > 0`; do not add catalog fields, a cumulative run ledger, a dependency, or an abstraction layer.
- Apply provider health to both production callers of `ModelRouter.route`: `WorkflowOrchestrator` and `ConversationOperationRunner`.
- Preserve model-pin validation, fallback ordering, error propagation, async ordering, persisted route decisions, metrics, events, and UI behavior.
- Run `npm run graphify:refresh` after code changes; keep generated `graphify-out/` state local and uncommitted.
- Completion requires `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, `git diff --check`, and live GitHub CI verification.

---

### Task 1: Enforce subscription quota budgets by observed usage

**Files:**

- Modify: `packages/model-router/src/score-router.test.ts`
- Modify: `packages/model-router/src/score-router.ts`

**Interfaces:**

- Consumes: `ModelMetric.quotaUnitsTotal?: number`, `quotaUnitsKnownCount?: number`, `RouteConstraints.budget.maxQuotaUnits?: number`, and `ExecutorHealth.rateLimit.remaining?: number`.
- Produces: unchanged `ModelRouter.route(profile, explicit?, constraints?)` with `over-budget: est <N> quota units > <N>` rejection when known average use exceeds available subscription quota.

- [ ] **Step 1: Add the explicit-budget regression**

Add beside the existing cost-budget tests in `packages/model-router/src/score-router.test.ts`:

```ts
it('rejects a subscription model whose observed quota use exceeds the remaining budget', async () => {
  const metric: ModelMetric = {
    modelId: 'quota-heavy',
    taskKind: 'implementation',
    role: 'developer',
    taxonomyVersion: '2',
    category: 'implementation/frontend',
    attempts: 2,
    successes: 2,
    totalDurationMs: 1_000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    quotaUnitsTotal: 4,
    quotaUnitsKnownCount: 2,
    consecutiveFailures: 0,
    qualityEvaluations: 0,
    qualityApprovals: 0,
    updatedAt: new Date().toISOString(),
  };
  const router = new ScoreBasedModelRouter(
    [model('quota-heavy', {}), model('metered-fallback', { billingMode: 'metered' })],
    new MemoryMetrics(new Map([['quota-heavy:implementation:developer', metric]])),
  );

  const decision = await router.route(profile, undefined, { budget: { maxQuotaUnits: 1 } });

  expect(decision.rejected).toContainEqual({
    modelId: 'quota-heavy',
    reason: 'over-budget: est 2 quota units > 1',
  });
});
```

- [ ] **Step 2: Verify RED**

Run `npx vitest run packages/model-router/src/score-router.test.ts -t "observed quota use exceeds"`.

Expected: FAIL because the current binary `maxQuotaUnits <= 0` gate leaves the model routable when one unit remains.

- [ ] **Step 3: Add the provider-availability regression**

Add a second test using the same complete metric with `attempts: 1`, `quotaUnitsTotal: 2`, and `quotaUnitsKnownCount: 1`:

```ts
it('uses provider-reported remaining units as the subscription quota budget', async () => {
  const metric: ModelMetric = {
    modelId: 'quota-heavy',
    taskKind: 'implementation',
    role: 'developer',
    taxonomyVersion: '2',
    category: 'implementation/frontend',
    attempts: 1,
    successes: 1,
    totalDurationMs: 1_000,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    quotaUnitsTotal: 2,
    quotaUnitsKnownCount: 1,
    consecutiveFailures: 0,
    qualityEvaluations: 0,
    qualityApprovals: 0,
    updatedAt: new Date().toISOString(),
  };
  const router = new ScoreBasedModelRouter(
    [model('quota-heavy', {}), model('metered-fallback', { billingMode: 'metered' })],
    new MemoryMetrics(new Map([['quota-heavy:implementation:developer', metric]])),
  );
  const providerHealth = new Map([
    [
      'claude',
      {
        provider: 'claude' as const,
        available: true,
        message: 'ok',
        rateLimit: { remaining: 1 },
      },
    ],
  ]);

  const decision = await router.route(profile, undefined, { providerHealth });

  expect(decision.rejected).toContainEqual({
    modelId: 'quota-heavy',
    reason: 'over-budget: est 2 quota units > 1',
  });
});
```

- [ ] **Step 4: Verify RED**

Run `npx vitest run packages/model-router/src/score-router.test.ts -t "provider-reported remaining units"`.

Expected: FAIL because positive `rateLimit.remaining` is not used as an available-unit budget.

- [ ] **Step 5: Implement the minimum comparison**

In `packages/model-router/src/score-router.ts`, retain the metered cost branch inside `if (budget)`, close that block immediately after the metered comparison, and replace the coarse subscription block with the following separate block. It must run even when `constraints.budget` is absent because `rl?.remaining` is itself the provider's available-unit budget:

```ts
if (model.billingMode === 'subscription') {
  const availableQuotaUnits = [budget?.maxQuotaUnits, rl?.remaining].filter(
    (value): value is number => value !== undefined,
  );
  const maxQuotaUnits =
    availableQuotaUnits.length > 0 ? Math.min(...availableQuotaUnits) : undefined;
  if (maxQuotaUnits !== undefined) {
    const estimate = estimateQuotaUnits(metric);
    if (estimate !== null && estimate > maxQuotaUnits) {
      return `over-budget: est ${estimate} quota units > ${maxQuotaUnits}`;
    }
    if (estimate === null && maxQuotaUnits <= 0) {
      return 'over-budget: no quota units remaining';
    }
  }
}
```

Add beside `estimateCostUsd`:

```ts
function estimateQuotaUnits(metric: ModelMetric | null): number | null {
  const knownCount = metric?.quotaUnitsKnownCount ?? 0;
  return metric?.quotaUnitsTotal !== undefined && knownCount > 0
    ? metric.quotaUnitsTotal / knownCount
    : null;
}
```

Do not round the comparison value and do not block positive unknown usage.

- [ ] **Step 6: Verify GREEN**

Run `npx vitest run packages/model-router/src/score-router.test.ts`.

Expected: all score-router tests PASS, including absent constraints and both new quota regressions.

- [ ] **Step 7: Commit Task 1**

```bash
git add packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts
git commit -m "fix(model-router): enforce quota budgets by observed usage (#62)"
```

### Task 2: Supply provider health to both production routing paths

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `docs/superpowers/specs/2026-07-18-usage-telemetry-normalization-design.md`

**Interfaces:**

- Consumes: `ExecutorRegistry.health(): Promise<ExecutorHealth[]>` and `RouteConstraints.providerHealth?: ReadonlyMap<string, ExecutorHealth>`.
- Produces: both production route calls pass `{ providerHealth: Map<provider, health> }`; `WorkflowOrchestrator` receives the existing registry as an optional final dependency and the conversation runner reuses its current registry.

- [ ] **Step 1: Add the failing workflow regression**

In `packages/orchestrator/src/workflow-orchestrator.test.ts`, import `ExecutorHealth` and `ExecutorRegistry`. Wrap the existing complete router function in `const route = vi.fn<ModelRouter['route']>(...)`, return `route` from `makeOrchestrator`, and change the helper signature to:

```ts
function makeOrchestrator(
  versions?: ProjectVersionService,
  executorHealth?: ExecutorHealth[],
) {
```

Build the optional dependency without changing the existing route fixture:

```ts
const executors: Pick<ExecutorRegistry, 'health'> | undefined = executorHealth
  ? { health: () => Promise.resolve(executorHealth) }
  : undefined;
```

Pass `executors` as the new final `WorkflowOrchestrator` constructor argument after the existing optional arguments, then add:

```ts
it('passes live provider health to every workflow route decision', async () => {
  const health: ExecutorHealth = {
    provider: 'codex',
    available: true,
    message: 'ok',
    rateLimit: { remaining: 1 },
  };
  const stores = makeOrchestrator(undefined, [health]);
  await seedRun(stores);

  await stores.orchestrator.runProject('project-1', undefined, 'run-1');

  expect(stores.route).toHaveBeenCalledWith(expect.anything(), undefined, {
    providerHealth: new Map([['codex', health]]),
  });
});
```

- [ ] **Step 2: Verify workflow RED**

Run `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts -t "live provider health"`.

Expected: FAIL because the workflow orchestrator has no health dependency and supplies no third route argument.

- [ ] **Step 3: Add the failing conversation regression**

In `packages/orchestrator/src/conversation-operation-runner.test.ts`, import `ExecutorHealth` and add a fourth defaulted argument to `setup`:

```ts
routing: { router?: ModelRouter; health?: ExecutorHealth[] } = {},
```

Use `routing.health ?? []` in the setup registry's `health` method and `routing.router ?? router` in the runner constructor. Add:

```ts
it('passes live provider health to conversation routing', async () => {
  const health: ExecutorHealth = {
    provider: 'codex',
    available: true,
    message: 'ok',
    rateLimit: { remaining: 1 },
  };
  const route = vi.fn<ModelRouter['route']>(router.route);
  const { conversations, runs, runner } = setup(
    harnessRepo,
    undefined,
    {},
    {
      router: { route, catalog: router.catalog },
      health: [health],
    },
  );
  const { runId, operationId } = await seed(conversations, runs, 'build');

  await runner.run('project-1', runId, operationId);

  expect(route).toHaveBeenCalledWith(expect.anything(), undefined, {
    providerHealth: new Map([['codex', health]]),
  });
});
```

- [ ] **Step 4: Verify conversation RED**

Run `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts -t "live provider health"`.

Expected: FAIL because the conversation runner routes before reading executor health.

- [ ] **Step 5: Implement both route call sites**

In `packages/orchestrator/src/workflow-orchestrator.ts`, import `ExecutorRegistry`, append this constructor dependency after `qualityObservations`, remove the obsolete deferred-wiring comment, and use:

```ts
private readonly executors?: Pick<ExecutorRegistry, 'health'>,
```

```ts
const providerHealth = this.executors
  ? new Map((await this.executors.health()).map((health) => [health.provider, health]))
  : undefined;
const route = await this.router.route(
  profile,
  explicit,
  providerHealth ? { providerHealth } : undefined,
);
```

In `packages/orchestrator/src/conversation-operation-runner.ts`, replace the route call with:

```ts
const providerHealth = new Map(
  (await this.executors.health()).map((health) => [health.provider, health]),
);
const route = await this.router.route(profile, undefined, { providerHealth });
```

Keep health failures visible; do not catch them or route unconstrained.

- [ ] **Step 6: Wire the existing registry in composition**

In `packages/composition/src/runtime.ts`, append `executors` after `qualityObservationService` in the existing `new WorkflowOrchestrator(...)` call. Do not change any registry or execution-plane behavior.

- [ ] **Step 7: Verify both regressions GREEN**

Run:

```bash
npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/conversation-operation-runner.test.ts
```

Expected: both files PASS and both routing paths expose the real health map to the router.

- [ ] **Step 8: Update the existing design document**

Edit `docs/superpowers/specs/2026-07-18-usage-telemetry-normalization-design.md` to state all of the following exactly:

- No cumulative run ledger is added; route-time provider health supplies available subscription units and explicit callers may still pass cost/quota budgets.
- Subscription quota estimate is `quotaUnitsTotal / quotaUnitsKnownCount` only for known samples and compares against the smaller of explicit `maxQuotaUnits` and provider `rateLimit.remaining`.
- Data flow now includes `ExecutorRegistry.health() -> RouteConstraints.providerHealth -> WorkflowOrchestrator / ConversationOperationRunner -> score-router`.
- Migration adds no schema or persisted shape; rollback is a straight code revert.
- Security uses existing bounded `--version` probes and sanitized `ExecutorHealth`; no provider stdout, credential, or new network input is persisted.

- [ ] **Step 9: Run focused verification and update the graph**

```bash
npx vitest run packages/model-router/src/score-router.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/conversation-operation-runner.test.ts packages/composition/src/runtime.integration.test.ts
npx prettier --check packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/conversation-operation-runner.ts packages/orchestrator/src/conversation-operation-runner.test.ts packages/composition/src/runtime.ts docs/superpowers/specs/2026-07-18-usage-telemetry-normalization-design.md
npm run graphify:refresh
```

Expected: focused tests PASS, formatting PASS, and graph update completes.

- [ ] **Step 10: Commit Task 2**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/conversation-operation-runner.ts packages/orchestrator/src/conversation-operation-runner.test.ts packages/composition/src/runtime.ts docs/superpowers/specs/2026-07-18-usage-telemetry-normalization-design.md
git commit -m "fix(orchestrator): apply provider constraints in production routes (#62)"
```

## Final Verification and Delivery

- [ ] Run Ponytail review and code-simplifier only on the branch diff; apply every safe in-scope finding and rerun affected tests.
- [ ] Run `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check`.
- [ ] Confirm `apps/web/next-env.d.ts` and unrelated generated files are absent from the diff.
- [ ] Push `issue-62-usage-routing`, open one PR with `Closes #62`, and include an acceptance-evidence table, security/migration/rollback, exact command results, and screenshots of focused routing evidence.
- [ ] Add the same observable evidence to a PR comment, verify all GitHub checks and review threads reach terminal success, and only then report completion.

## Self-Review

- **Spec coverage:** Task 1 closes the audited binary subscription-budget gap. Task 2 closes the audited unreachable-production gap for both router callers. Previously merged UsageReport, unknown semantics, ProviderHealth shape, provider fixtures, persistence, and UI criteria remain covered by the full gate.
- **Placeholder scan:** No `TBD`, `TODO`, “implement later”, generic validation instruction, or undefined interface remains.
- **Type consistency:** `ExecutorRegistry.health`, `ExecutorHealth`, `RouteConstraints.providerHealth`, `ModelMetric.quotaUnitsTotal`, and `quotaUnitsKnownCount` match current exports. The only constructor change is an optional final orchestration dependency wired by composition.
