# Issue 191 Sandbox Destroy Failure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the completed sandbox lifecycle result or original lifecycle error when best-effort sandbox destruction fails, while recording the cleanup failure.

**Architecture:** Retain the `finally` cleanup boundary in `runSandboxLifecycle`; make only `runner.destroy(sandbox)` best effort with a narrow catch and a standard error log. This keeps create/exec/snapshot semantics and all caller interfaces unchanged.

**Tech Stack:** TypeScript, Node console logging, Vitest.

## Global Constraints

- Issue #191 must call `destroy` once for every sandbox successfully created.
- A destroy failure after success must not reject the successful `{ result, snapshot }` value.
- A destroy failure after exec or snapshot failure must not mask the original lifecycle error.
- Log the cleanup error; do not add a logger parameter, dependency, retry policy, or new error type.
- Follow TDD: observe success and original-error preservation fail before production code is changed.
- Work only on branch `fix/issue-191-sandbox-destroy`; do not merge or push to `main`.

---

### Task 1: Make sandbox destruction best effort without masking lifecycle outcomes

**Files:**

- Modify: `packages/domain/src/sandbox-runner.ts`
- Modify: `packages/domain/src/sandbox-runner.test.ts`

**Interfaces:**

- Consumes: `SandboxRunner.destroy(sandbox): Promise<void>`.
- Produces: unchanged `runSandboxLifecycle(...)` return type and primary error behavior.
- Preserves: allowlist validation, output forwarding, snapshot filtering, and cleanup after exec/snapshot failure.

- [ ] **Step 1: Write failing destroy-failure tests**

Extend `FakeSandboxRunner` with a `destroy` failure mode after recording the destroy attempt. Add one test that resolves the normal lifecycle despite `destroy failed` and one that rejects with `exec failed` when both exec and destroy fail. Spy on `console.error` in each test and assert it receives the cleanup error; restore the spy before the test ends.

```ts
await expect(runSandboxLifecycle(runner, spec, request, ['src'])).resolves.toMatchObject({
  result: { exitCode: 0 },
});
await expect(runSandboxLifecycle(failingRunner, spec, request, ['src'])).rejects.toThrow(
  'exec failed',
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:unit -- packages/domain/src/sandbox-runner.test.ts`

Expected: FAIL because an exception from `finally { await runner.destroy(...) }` currently rejects the success path and replaces the exec error.

- [ ] **Step 3: Implement narrow cleanup error isolation**

Replace the unconditional await in `finally` with:

```ts
try {
  await runner.destroy(sandbox);
} catch (error) {
  console.error('Failed to destroy sandbox', error);
}
```

Do not catch errors from `exec` or `snapshot`; only cleanup failures are non-fatal.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test:unit -- packages/domain/src/sandbox-runner.test.ts`

Expected: PASS with successful results and original exec errors preserved, plus an observable cleanup log.

- [ ] **Step 5: Run package-local validation**

Run: `npm run typecheck --workspace @agent-foundry/domain && npm run lint:code -- --quiet`

Expected: PASS.

- [ ] **Step 6: Commit the issue change**

```bash
git add docs/superpowers/plans/2026-07-22-issue-191-sandbox-destroy.md packages/domain/src/sandbox-runner.ts packages/domain/src/sandbox-runner.test.ts
git commit -m "fix(sandbox): preserve lifecycle errors on destroy failure"
```
