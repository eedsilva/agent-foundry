# Issue 195 Late Preview Port Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `NodePreviewRunner.health()` probe the actual port as soon as process output reports it, including after the bounded startup-confirm window has ended.

**Architecture:** The in-memory `ProcessEntry` is the sole port source used by `health()`. Update that entry in the output capture callback when `detectPortFromOutput` yields a port, while retaining the startup loop’s existing immediate readiness behavior and persisted process-port result. Extend the existing fixture only enough to emulate a server that ignores `PORT` and prints a delayed Vite-style banner.

**Tech Stack:** TypeScript, Node HTTP/net fixtures, execa, Vitest.

## Global Constraints

- Issue #195 must preserve the reserved `PORT`/`HOST` environment behavior and the one-retry immediate-crash policy.
- A port printed after `startupTimeoutMs` must be used by later `health()` calls without restarting the process.
- Do not add polling, dependencies, or a second process registry.
- Follow TDD: observe the late-detection health test fail before production code is changed.
- Work only on branch `fix/issue-195-late-preview-port`; do not merge or push to `main`.

---

### Task 1: Update tracked port from delayed dev-server output

**Files:**

- Modify: `packages/executors/src/node-preview-runner.ts`
- Modify: `packages/executors/src/node-preview-runner.test.ts`
- Modify: `packages/executors/src/fixtures/preview-dev-server.mjs`

**Interfaces:**

- Consumes: `detectPortFromOutput(text): number | undefined`, `ProcessEntry.port`, and the `PreviewRunner.health(session)` contract.
- Produces: `health(session)` probes the latest detected output port for a tracked, live process.
- Preserves: `start(session).process.port` returns the port known when startup completes; no persistence or API contract changes.

- [ ] **Step 1: Write the failing late-output integration test**

Add a test near the existing health tests that reserves one free port for the runner and starts the fixture on another free `--fixed-port`. Pass `--ready-delay-ms=150` and use `startupTimeoutMs: 25` so `start()` returns before the fixture prints its URL. Assert the returned process port is the reserved port, then wait for:

```ts
await vi.waitFor(async () => {
  await expect(runner.health(session)).resolves.toMatchObject({ state: 'healthy' });
});
```

The fixture options required by the test are `--fixed-port=<port>` (takes precedence over `process.env.PORT`) and `--ready-delay-ms=<ms>` (delays only the ready banner).

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run test:unit -- packages/executors/src/node-preview-runner.test.ts`

Expected: FAIL because output arriving after the startup loop updates only a local `detectedPort`; `ProcessEntry.port` remains the reserved port and health stays unhealthy.

- [ ] **Step 3: Implement the smallest shared-state update**

In the capture callback, assign a newly detected port to both the local startup candidate and `entry.port`:

```ts
const port = detectPortFromOutput(text);
if (port !== undefined) {
  detectedPort = port;
  entry.port = port;
}
```

Keep the existing HTTP probe loop unchanged. In the fixture, parse its arguments before selecting the listen port, let `--fixed-port` override the environment port, and wrap only the ready console output (and `--exit-after-ready` timer) in the requested delay.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run test:unit -- packages/executors/src/node-preview-runner.test.ts`

Expected: PASS, including the delayed-output regression test and cleanup.

- [ ] **Step 5: Run package-local validation**

Run: `npm run typecheck --workspace @agent-foundry/executors && npm run lint:code -- --quiet`

Expected: PASS.

- [ ] **Step 6: Commit the issue change**

```bash
git add docs/superpowers/plans/2026-07-22-issue-195-late-preview-port.md packages/executors/src/node-preview-runner.ts packages/executors/src/node-preview-runner.test.ts packages/executors/src/fixtures/preview-dev-server.mjs
git commit -m "fix(preview): track ports detected after startup"
```
