# ResetAt-Only Rate-Limit Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exclude a provider from routing whenever its health reports a future rate-limit reset, including providers that omit `remaining`.

**Architecture:** Keep the rate-limit decision in `ScoreBasedModelRouter.constraintRejection`, the shared guard that every constrained route uses. Treat a future `resetAt` as the hard-limit signal; do not change the health contract, parser, scoring, or fallback selection. Prove the public `route()` result rejects a provider whose rate limit has only `resetAt`.

**Tech Stack:** TypeScript, Vitest, npm workspaces, GitHub Actions, Playwright.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-190-reset-at-gate` on `fix/issue-190-reset-at-gate`; never push code to `main`.
- Do not add dependencies, types, parsers, abstractions, or configuration for this single shared guard.
- Preserve existing behavior when `resetAt` is absent or in the past.
- Use TDD: observe the focused regression fail before changing production code, then make it pass with the smallest shared-router change.
- Before the PR, pass `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check`.

---

## File Structure

- `packages/model-router/src/score-router.ts` owns constrained candidate rejection. Its existing rate-limit branch is the single root cause because every eligible model is evaluated through `constraintRejection`.
- `packages/model-router/src/score-router.test.ts` owns public routing behavior tests and already verifies the adjacent `remaining: 0` plus future `resetAt` scenario.
- `docs/superpowers/plans/2026-07-20-issue-190-reset-at-gate.md` records the issue-specific execution and validation steps.

### Task 1: Gate Future ResetAt Without Requiring Remaining

**Files:**

- Modify: `packages/model-router/src/score-router.ts:138-142`
- Modify: `packages/model-router/src/score-router.test.ts:414-433`
- Create: `docs/superpowers/plans/2026-07-20-issue-190-reset-at-gate.md`

**Interfaces:**

- Consumes: `RouteConstraints.providerHealth?: Map<Provider, ExecutorHealth>` and `ExecutorHealth.rateLimit?: { remaining?: number; resetAt?: string }`.
- Produces: `ScoreBasedModelRouter.route()` rejects each affected candidate with `rate-limited until <resetAt>` before ranking and fallback selection.

- [ ] **Step 1: Write the failing public routing regression**

  Add this test immediately after the existing future-reset rate-limit test in `packages/model-router/src/score-router.test.ts`:

  ```ts
  it('excludes a model when its provider reports only a future rate-limit reset', async () => {
    const router = new ScoreBasedModelRouter(twoProviderCatalog(), new MemoryMetrics());
    const health = new Map([
      [
        'claude',
        {
          provider: 'claude' as const,
          available: true,
          message: 'ok',
          rateLimit: { resetAt: '2999-01-01T00:00:00.000Z' },
        },
      ],
    ]);

    const decision = await router.route(profile, undefined, { providerHealth: health });

    expect(decision.selected.model.provider).not.toBe('claude');
    expect(decision.rejected).toContainEqual({
      modelId: 'claude-metered',
      reason: 'rate-limited until 2999-01-01T00:00:00.000Z',
    });
  });
  ```

- [ ] **Step 2: Run the focused test to verify RED**

  Run:

  ```bash
  npm test -- --run packages/model-router/src/score-router.test.ts
  ```

  Expected: the new test fails because the current guard requires `rl.remaining === 0`, so Claude remains eligible and is not rejected.

- [ ] **Step 3: Replace the conjunctive guard with the reset-based guard**

  In `packages/model-router/src/score-router.ts`, replace:

  ```ts
  if (rl && rl.remaining === 0 && rl.resetAt && new Date(rl.resetAt).getTime() > Date.now()) {
  ```

  with:

  ```ts
  if (rl?.resetAt && new Date(rl.resetAt).getTime() > Date.now()) {
  ```

  Leave the rejection message and every budget branch unchanged. The reset timestamp is already the health contract's hard-limit expiry signal, so no new parser or fallback logic is required.

- [ ] **Step 4: Run the focused router suite to verify GREEN**

  Run:

  ```bash
  npm test -- --run packages/model-router/src/score-router.test.ts
  ```

  Expected: all router tests pass, including the resetAt-only provider regression.

- [ ] **Step 5: Review the focused diff and commit**

  Run:

  ```bash
  git diff --check
  git diff -- packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts
  ```

  Expected: one condition change and one public regression test, with no unrelated generated files.

  Commit:

  ```bash
  git add docs/superpowers/plans/2026-07-20-issue-190-reset-at-gate.md packages/model-router/src/score-router.ts packages/model-router/src/score-router.test.ts
  git commit -m "fix(router): gate future rate-limit resets"
  ```

### Task 2: Validate, Review, and Publish the Isolated Branch

**Files:**

- Modify only if a reviewer identifies a concrete defect in the Task 1 files.

**Interfaces:**

- Consumes: committed Task 1 branch and its focused regression evidence.
- Produces: an issue-linked PR whose local and remote checks demonstrate #190's resetAt-only provider is not routable.

- [ ] **Step 1: Run repository validation**

  Run:

  ```bash
  npm run check
  npm run e2e --workspace @agent-foundry/api
  npm run doctor
  git diff --check
  ```

  Expected: `check` passes format, lint, architecture, roadmap, typecheck, unit/script tests, and build; API Playwright reports 4 passing tests; doctor reports the mock executor environment ready; diff check exits zero.

- [ ] **Step 2: Perform focused and whole-branch review**

  Review the final diff against #190 with these acceptance checks:

  ```text
  A future resetAt with no remaining field rejects the provider.
  A future resetAt keeps the existing rejection message.
  No change affects absent or expired resetAt behavior.
  No code outside the router guard, its public test, and the required plan is added.
  ```

  Run the Ponytail and simplification reviews. If either reports a concrete defect, add a focused failing regression first, make the smallest correction, rerun the focused suite, and repeat review.

- [ ] **Step 3: Push and create the issue-linked PR**

  Run:

  ```bash
  git push -u origin fix/issue-190-reset-at-gate
  gh pr create --base main --head fix/issue-190-reset-at-gate --title "fix(router): gate future rate-limit resets" --body $'Fixes #190\n\n## Evidence\n\n- Regression: a provider that reports only a future resetAt is rejected from routing.\n- Focused router suite, full check, API Playwright e2e, doctor, and diff check passed.'
  ```

  Expected: GitHub returns the URL of an open PR targeting `main`; no commit is pushed directly to `main`.

- [ ] **Step 4: Confirm remote evidence**

  Run:

  ```bash
  gh pr checks --repo eedsilva/agent-foundry --watch
  gh pr view --repo eedsilva/agent-foundry --json url,state,mergeStateStatus,statusCheckRollup
  ```

  Expected: all required format, lint, architecture, roadmap, typecheck, test, build, dependency, and CodeQL checks succeed, and the PR has a clean merge state.
