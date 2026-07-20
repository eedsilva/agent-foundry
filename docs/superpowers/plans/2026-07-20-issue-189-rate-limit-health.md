# Issue #189 Failed-Run Rate-Limit Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve provider rate-limit telemetry when a CLI run fails, so router health can exclude an exhausted provider.

**Architecture:** Read the existing trusted stdout rate-limit hint immediately after stdout is collected and before either error branch. `health()` and all error semantics stay unchanged; only the existing two-line assignment moves. Tests exercise both failures called out in #189 through the public executor and health APIs.

**Tech Stack:** TypeScript, Vitest, existing `BaseCliExecutor` fixture, existing `extractRateLimit()` parser.

## Global Constraints

- Work only on `fix/issue-189-rate-limit-health`; never push directly to `main`.
- Modify only the executor, its colocated test, and this plan; add no dependencies, parser, or error wrapper.
- Use only collected provider stdout and preserve current errors, error payloads, and cleanup.
- Cover a non-zero process exit and an exit-0 `is_error: true` provider envelope test-first.
- Before PR publication, `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check` must pass.
- The PR must use `Fixes #189` and report focused plus full validation evidence.

---

## File Structure

- `packages/executors/src/base-cli-executor.ts` — records rate-limit data before throwing branches.
- `packages/executors/src/base-cli-executor.test.ts` — public failed-run health regressions.

### Task 1: Capture rate-limit hints before failures

**Files:**

- Modify: `packages/executors/src/base-cli-executor.ts:142-173`
- Modify: `packages/executors/src/base-cli-executor.test.ts:240-260`
- Create: `docs/superpowers/plans/2026-07-20-issue-189-rate-limit-health.md`

**Interfaces:**

- Consumes: `extractRateLimit(provider, stdout): ProviderRateLimit | undefined`.
- Produces: unchanged `BaseCliExecutor.execute()` error semantics and existing `health()` rate-limit field after a parsed stdout.

- [x] **Step 1: Write the raw-output test fixture and failing regressions**

Add below `FixtureExecutor`:

```ts
class RawOutputFixtureExecutor extends FixtureExecutor {
  protected override async responseText(
    _invocation: CliInvocation,
    stdout: string,
  ): Promise<string> {
    return stdout;
  }
}
```

Add these tests to `describe('BaseCliExecutor rate limit (issue #62)', ...)`:

```ts
it('keeps a rate limit reported with a non-zero exit in health()', async () => {
  const executor = new FixtureExecutor(1_000_000, undefined, 'claude');
  execaMock.mockResolvedValueOnce({
    exitCode: 1,
    stderr: 'rate limited',
    stdout: fixture('claude.rate-limited.stdout.json'),
  });
  await expect(executor.execute(request)).rejects.toThrow('CLI exited with code 1');
  execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'claude-cli 1.0.0', stderr: '' });
  await expect(executor.health()).resolves.toMatchObject({
    rateLimit: { limit: 100, remaining: 0, resetAt: '2026-07-18T13:00:00.000Z' },
  });
});

it('keeps a rate limit reported with an error artifact in health()', async () => {
  const executor = new RawOutputFixtureExecutor(1_000_000, undefined, 'claude');
  execaMock.mockResolvedValueOnce({
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      rate_limit: { limit: 2, remaining: 0, reset_at: '2026-07-20T12:00:00.000Z' },
    }),
  });
  await expect(executor.execute(request)).rejects.toThrow('Agent did not return a valid artifact');
  execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'claude-cli 1.0.0', stderr: '' });
  await expect(executor.health()).resolves.toMatchObject({
    rateLimit: { limit: 2, remaining: 0, resetAt: '2026-07-20T12:00:00.000Z' },
  });
});
```

- [x] **Step 2: Run the regressions red**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts -t "keeps a rate limit reported" --pool=threads --maxWorkers=1`

Expected: FAIL because `lastRateLimit` is assigned only after both the exit-code and artifact parsing failure paths.

- [x] **Step 3: Move the existing extraction before the first throw path**

Immediately after:

```ts
const stdout = outputText(result.stdout);
const stderr = outputText(result.stderr);
```

insert:

```ts
const rateLimit = extractRateLimit(this.provider, stdout);
if (rateLimit) this.lastRateLimit = rateLimit;
```

Remove those same two lines after `const usage = extractUsage(this.provider, stdout);`. Do not catch or transform errors.

- [x] **Step 4: Run the full executor test file green**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts --pool=threads --maxWorkers=1`

Expected: PASS, including existing success health coverage and both newly failing paths.

- [x] **Step 5: Commit the scoped fix**

```bash
git add packages/executors/src/base-cli-executor.ts packages/executors/src/base-cli-executor.test.ts docs/superpowers/plans/2026-07-20-issue-189-rate-limit-health.md
git commit -m "fix(executors): retain rate limits from failed runs"
```

### Task 2: Validate and publish evidence

**Files:**

- Modify: none

**Interfaces:**

- Consumes: Task 1's committed executor change.
- Produces: a PR linked to #189 with reproducible evidence.

- [ ] **Step 1: Run all local quality gates**

Run: `npm run check && npm run e2e --workspace @agent-foundry/api && npm run doctor && git diff --check`

Expected: every command exits `0`; `npm run check` covers format, lint, architecture, roadmap, typecheck, tests, and build.

- [ ] **Step 2: Perform the complexity and behavior-preservation review**

Run: `git diff origin/main...HEAD -- packages/executors/src/base-cli-executor.ts packages/executors/src/base-cli-executor.test.ts`

Expected: one moved extraction block, one raw-output test fixture, and two failure-path tests; no new dependency, parser, or error propagation change.

- [ ] **Step 3: Push and create the issue-linked PR**

Run: `git push -u origin fix/issue-189-rate-limit-health`

Run: `gh pr create --base main --head fix/issue-189-rate-limit-health --title "fix(executors): retain rate limits from failed runs" --body-file /tmp/issue-189-pr.md`

Write `/tmp/issue-189-pr.md` with `Fixes #189`, both failed-run scenarios, the focused executor test command, and the four full-gate commands/results before running `gh pr create`.

Expected: the returned PR has a non-main head branch, closes #189 on merge, and presents reproducible evidence.
