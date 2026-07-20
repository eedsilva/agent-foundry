# Issue #188 Known-Cost Router Estimate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the model router from treating attempts without a provider-reported cost as zero-cost observations.

**Architecture:** Keep the existing `ModelMetric.costKnownCount` discriminator as the sole divisor for a historical per-attempt cost. If no known-cost observation exists, retain the existing catalog-pricing fallback. The regression test exercises the public routing budget gate, so it proves the reported underestimation cannot select the exhausted model.

**Tech Stack:** TypeScript, npm workspaces, Vitest, existing `ScoreBasedModelRouter` and in-memory metrics test double.

## Global Constraints

- Work only on `fix/issue-188-known-cost`; never push directly to `main`.
- Change only `packages/model-router/src/score-router.ts`, its colocated test, and this plan; add no dependencies or new abstractions.
- `undefined`/absent cost remains unknown; never infer a zero cost from attempts without a reported cost.
- Preserve the existing catalog-pricing fallback when `costKnownCount` is absent or zero.
- Follow TDD: run the focused regression test red before production code, then green.
- Before opening the PR, `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check` must pass.
- PR body must link `Fixes #188`, state the failure scenario, and include the focused and full-gate command results.

---

## File Structure

- `packages/model-router/src/score-router.ts` — divides historical cost only by provider-reported cost observations.
- `packages/model-router/src/score-router.test.ts` — regression coverage for a metered model with partial cost reporting and a budget gate.

### Task 1: Use known-cost observations for the historical estimate

**Files:**

- Modify: `packages/model-router/src/score-router.ts:312-314`
- Modify: `packages/model-router/src/score-router.test.ts:435-442`
- Create: `docs/superpowers/plans/2026-07-20-issue-188-known-cost.md`

**Interfaces:**

- Consumes: `ModelMetric.costKnownCount?: number` and `ModelMetric.totalEstimatedCostUsd: number`.
- Produces: unchanged `ScoreBasedModelRouter.route(profile, explicit?, constraints?)` behavior, except historical cost now averages only observations that reported a cost.

- [ ] **Step 1: Write the failing public budget-gate regression test**

Insert this test after the existing `rejects a metered model that exceeds the cost budget` test in `packages/model-router/src/score-router.test.ts`:

```ts
it('does not treat attempts without reported cost as zero-cost history', async () => {
  const now = new Date().toISOString();
  const metrics = new MemoryMetrics(
    new Map([
      [
        'partially-priced:implementation:developer',
        {
          modelId: 'partially-priced',
          taskKind: 'implementation',
          role: 'developer',
          taxonomyVersion: '2',
          category: 'implementation/frontend',
          attempts: 10,
          successes: 10,
          totalDurationMs: 1_000,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalEstimatedCostUsd: 2,
          costKnownCount: 2,
          consecutiveFailures: 0,
          qualityEvaluations: 0,
          qualityApprovals: 0,
          updatedAt: now,
        },
      ],
    ]),
  );
  const router = new ScoreBasedModelRouter(
    [
      model('partially-priced', {
        billingMode: 'metered',
        pricing: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 },
      }),
      model('subscription-fallback', { provider: 'codex' }),
    ],
    metrics,
  );

  const decision = await router.route(profile, undefined, { budget: { maxCostUsd: 0.5 } });

  expect(decision.rejected).toContainEqual({
    modelId: 'partially-priced',
    reason: 'over-budget: est $1.0000 > $0.5',
  });
});
```

- [ ] **Step 2: Run the regression test and verify it fails for the reported bug**

Run: `npx vitest run packages/model-router/src/score-router.test.ts -t "does not treat attempts without reported cost" --pool=threads --maxWorkers=1`

Expected: FAIL because the current `2 / 10` estimate is `$0.2000`, so `partially-priced` is not rejected by the `$0.5` budget.

- [ ] **Step 3: Change the historical divisor to the known-cost count**

Replace the historical-cost branch in `estimateCostUsd()` with:

```ts
const costKnownCount = metric?.costKnownCount ?? 0;
if (metric && costKnownCount > 0 && metric.totalEstimatedCostUsd > 0) {
  return metric.totalEstimatedCostUsd / costKnownCount;
}
```

Leave the existing `model.pricing` fallback unchanged. Do not use `attempts` as the divisor when costs are partially or wholly unknown.

- [ ] **Step 4: Run the focused router suite and verify it passes**

Run: `npx vitest run packages/model-router/src/score-router.test.ts --pool=threads --maxWorkers=1`

Expected: PASS, including the new budget rejection at `$1.0000` and existing pricing fallback behavior.

- [ ] **Step 5: Commit the scoped fix**

```bash
git add packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts docs/superpowers/plans/2026-07-20-issue-188-known-cost.md
git commit -m "fix(router): average cost by known observations"
```

### Task 2: Validate and publish evidence

**Files:**

- Modify: none

**Interfaces:**

- Consumes: the committed Task 1 router change.
- Produces: a PR linked to #188 with reproducible command evidence.

- [ ] **Step 1: Run all local quality gates**

Run: `npm run check && npm run e2e --workspace @agent-foundry/api && npm run doctor && git diff --check`

Expected: every command exits `0`; `npm run check` includes format, lint, architecture, roadmap, typecheck, unit/script tests, and build.

- [ ] **Step 2: Review the PR diff for unnecessary complexity**

Run: `git diff origin/main...HEAD -- packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts`

Expected: one divisor change plus one public regression test; no dependencies, schema changes, or unrelated router behavior.

- [ ] **Step 3: Push and open the issue-linked PR**

```bash
git push -u origin fix/issue-188-known-cost
gh pr create --base main --head fix/issue-188-known-cost --title "fix(router): average cost by known observations" --body $'Fixes #188\n\n## Evidence\n\n- Regression: a model with `$2` across 2 reported-cost attempts and 8 unknown-cost attempts is rejected by a `$0.50` budget as `$1.0000` per attempt.\n- Focused: `npx vitest run packages/model-router/src/score-router.test.ts --pool=threads --maxWorkers=1`\n- Full: `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check`.'
```

Expected: a PR URL is returned, `Fixes #188` is present, and its head branch is not `main`.
