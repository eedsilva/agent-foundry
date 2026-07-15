# Failure Injection Suite Implementation Plan (issue #11)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CI-safe suite that injects timeout, invalid output, rate limit, process kill, dead worker, phase crashes and duplicate delivery into the orchestrator, and proves every scenario ends in a valid final or resumable state without duplicating artifacts or commits.

**Architecture:** Generalize the proven pattern from `packages/orchestrator/src/run-controls.test.ts` (in-memory ports + `PowerSwitch` phase-crash injection + `ControllableExecutor`) into a shared harness module, then build a phase×failure matrix suite on top. Queue-level dead-worker/duplicate-delivery scenarios use the real `FileJobQueue` in a temp dir with a fake clock (pattern from `packages/persistence/src/job-queue.test.ts`). No real CLIs anywhere.

**Tech Stack:** TypeScript, vitest (fake timers, `vi.waitFor`), in-memory domain ports, `FileJobQueue` on `mkdtemp` dirs.

## Global Constraints

- Zero production-code changes expected. This issue is `kind:test`. If a test reveals a real bug, fix it minimally in a separate commit with its own failing-test-first cycle, and record it in the PR description (failures become data, not silence).
- No new dependencies. No real CLI invocation (`EXECUTOR_MODE` never `real`). Suite must pass under `npm run test:unit` (single worker).
- Do NOT add new error classes to `packages/domain/src/errors.ts` — rate limit/timeout fixtures emulate today's real surface: generic `ExecutionError` with `details.exitCode`/`stdout`/`stderr` (see `packages/executors/src/base-cli-executor.ts:141-149`, `packages/executors/src/json-output.ts:4-17`).
- `cancellation.test.ts` stays untouched (its harness variant differs deliberately).
- `npm run check` must pass at the end.

---

### Task 1: Extract the shared in-memory harness

**Files:**

- Create: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/run-controls.test.ts` (import from harness; delete the moved ~500 lines)

**Interfaces:**

- Produces (moved verbatim from `run-controls.test.ts`, exported): `PowerSwitch`, `checkPower`, `SequentialIds`, `FixedClock` (if present), `InMemoryProjects`, `InMemoryRuns`, `InMemoryStepRuns`, `InMemoryStepAttempts`, `InMemoryArtifacts` (with `onAfterPut` hook), `InMemoryEvents`, `FakeWorkspaces` (with `onAfterCommit` hook; Task 3 adds more hooks), `ControllableExecutor`, `makeStores(): Stores`, `makeHarness(behaviors, existing?: Stores)`, `seedRun`, `completeRun`, `liveStepRun`, plus their types (`Stores`, `Harness`, `ExecutorBehavior`).

Rules for the move:

- The harness module must not import `vitest` (no `vi.*` inside it) — keep `vi.waitFor` calls in test files.
- Copy signatures exactly as they exist in `run-controls.test.ts` today; this is a mechanical extraction, not a redesign.
- `run-controls.test.ts` keeps its `describe`/`it` blocks and any helper used only by a single test.

- [ ] **Step 1:** Read `packages/orchestrator/src/run-controls.test.ts` fully. Move the harness pieces to `packages/orchestrator/src/testing/harness.ts`; update imports in `run-controls.test.ts`.
- [ ] **Step 2:** Run `npx vitest run packages/orchestrator/src/run-controls.test.ts` — all existing tests still PASS (proof the extraction changed nothing).
- [ ] **Step 3:** Run `npm run typecheck && npm run lint` — the new file compiles under `tsconfig` `include: ["src/**/*.ts"]` like the test files do.
- [ ] **Step 4: Commit** — `refactor(orchestrator): extract shared in-memory test harness`

---

### Task 2: Scripted failure behaviors for the executor + workspace hooks

**Files:**

- Modify: `packages/orchestrator/src/testing/harness.ts`

**Interfaces:**

- Produces: extended behavior union consumed by Task 3:

```ts
export type StepBehavior =
  | 'instant'
  | 'gated'
  | { kind: 'fail-once'; error: () => Error } // fails on first execution of the step, succeeds after
  | { kind: 'fail-always'; error: () => Error }
  | { kind: 'hang-until-abort' }; // resolves only when signal aborts, rejecting with the abort reason

export function timeoutError(): Error; // new ExecutionError('Command timed out after 300000 milliseconds: codex ...', { provider: 'mock', exitCode: undefined, stderr: '' }) — mirror execa timeout surface in base-cli-executor
export function rateLimitError(): Error; // new ExecutionError('CLI exited with a failure status', { exitCode: 1, stderr: '429 Too Many Requests: rate limit reached' })
export function invalidOutputError(): Error; // new ExecutionError('Agent did not return a valid artifact JSON object', { stdout: 'not json at all' }) — mirror json-output.ts
```

- Also add to `FakeWorkspaces`: optional hooks `onBeforeCheckpoint`, `onAfterCheckpoint`, `onBeforeCommit` (in addition to existing `onAfterCommit`), each `(() => void) | undefined`, invoked at the matching point in `checkpoint()`/`commit()`. Also ensure `ControllableExecutor` can `touch()` the workspace (dirty it) before failing — add optional `dirtyWorkspace?: FakeWorkspaces` wiring or a per-behavior `beforeResult?: () => void` callback (choose whichever is smaller given the current class shape; keep it one mechanism, not both).

- [ ] **Step 1: Write failing unit tests** in `packages/orchestrator/src/failure-injection.test.ts` (this file grows in Task 3; start it here) covering just the fixtures:

```ts
describe('failure fixtures', () => {
  it('fail-once fails the first execution and succeeds on the second', async () => { ... });
  it('hang-until-abort rejects when the signal aborts', async () => { ... });
  it('error factories produce ExecutionError with the real-world shape', () => {
    expect(timeoutError()).toBeInstanceOf(ExecutionError);
    expect(rateLimitError().details.stderr).toContain('429');
    expect(invalidOutputError().message).toContain('valid artifact JSON');
  });
});
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement in the harness. **Step 4:** Run — PASS.
- [ ] **Step 5: Commit** — `test(orchestrator): scripted executor failure behaviors and workspace hooks`

---

### Task 3: The failure matrix suite

**Files:**

- Create/extend: `packages/orchestrator/src/failure-injection.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–2. Workflow fixtures: reuse whatever minimal workflow definition `run-controls.test.ts` uses (single mutating `developer` step + optionally a second node) via `makeHarness`.

Scenario groups — each `it` asserts BOTH the immediate outcome AND the terminal invariant (valid final state or successful replay to completion):

**Group A — executor failure modes with fallback recovery.** Route must offer ≥2 candidates (mirror how `run-controls.test.ts` configures the router/candidates; if the harness router yields a single candidate, configure two mock models). For each of `timeoutError`, `rateLimitError`, `invalidOutputError`:

```ts
it.each([
  ['timeout', timeoutError],
  ['rate limit', rateLimitError],
  ['invalid output', invalidOutputError],
])('recovers from %s via fallback with workspace restored', async (_, error) => {
  // behaviors: developer step = { kind: 'fail-once', error } and dirties the workspace before failing
  // run to completion
  // assert: run completed; two StepAttempts (failed then succeeded);
  //   failed attempt has error persisted + a `run-<attemptId>-failure` artifact;
  //   workspaces.rollbacks contains the checkpoint BEFORE the second attempt started
  //   (fallback restores workspace before next attempt);
  //   exactly ONE final commit for the step (workspaces.commits length);
  //   metrics recorded a failure and a success.
});

it('fails the run with a valid terminal state when all candidates fail', async () => {
  // fail-always; assert run status 'failed', step 'failed', attempts all 'failed',
  // final rollback happened (workspaces.rollbacks), project status 'failed',
  // and a subsequent runProject(projectId, wf, runId) is a NO-OP (terminal run guard).
});
```

**Group B — process kill (late result must not be promoted).**

```ts
it('never promotes a result that arrives after cancellation (process kill)', async () => {
  // behaviors: developer = { kind: 'hang-until-abort' }
  // start runProject (don't await); wait until executor started; cancelRun(runId);
  // await runProject settle.
  // assert: run 'cancelled', attempt 'cancelled', NO commit recorded after cancel,
  // workspace rolled back to checkpoint, no output artifact for the step.
});
```

**Group C — phase crash matrix (PowerSwitch) + replay.** Cells marked `(covered)` already exist in `run-controls.test.ts` — do NOT duplicate them; the matrix table in a comment names where each cell lives:

| Phase boundary                            | Where covered                  |
| ----------------------------------------- | ------------------------------ |
| before checkpoint                         | NEW (C1)                       |
| after checkpoint, before execution        | NEW (C2)                       |
| mid-execution (executor dies with power)  | NEW (C3)                       |
| after execution, before commit            | NEW (C4)                       |
| after commit, before artifact put         | (covered) run-controls.test.ts |
| after artifact put, before attempt update | (covered) run-controls.test.ts |
| before queue ack                          | (covered) run-controls.test.ts |
| after ack (redelivery of completed run)   | NEW (C5)                       |

Each NEW cell follows the exact recipe of the existing crash tests (read them first):

```ts
it('C1: crash before checkpoint is resumable without duplicate side effects', async () => {
  // workspaces.onBeforeCheckpoint = () => { power.on = false; }
  // first runProject rejects with 'simulated power loss'
  // power.on = true; build a FRESH harness over the SAME stores (restart);
  // runProject again → completes.
  // assert: exactly one checkpoint per mutating step, one commit, one output artifact revision,
  // executor startCounts per step === expected (no double execution where reuse applies),
  // events deduped (no duplicated node.started/completed for replayed steps).
});
// C2: workspaces.onAfterCheckpoint kills power → replay; same invariants.
// C3: developer behavior fails with checkPower error mid-execute → replay; the interrupted
//     'running' attempt must be finalized as failed-interrupted and the step re-executed
//     (assert the 'Interrupted before completion; superseded by replay.' path or reuse path).
// C4: executor succeeds but onBeforeCommit kills power → replay; assert NO orphan commit,
//     step re-executes or reuses per idempotency, final state has exactly one commit.
// C5: complete a run fully (job acked); enqueue/deliver the same job again;
//     assert runProject is a no-op: no new attempts, artifacts, commits, or events.
```

**Group D — duplicate delivery & dead worker over the REAL `FileJobQueue`** (temp dir + `FakeClock`, pattern from `packages/persistence/src/job-queue.test.ts:9-30`):

```ts
it('dead worker: expired lease is reaped and redelivery completes the run exactly once', async () => {
  // enqueue job; workerA = queue.claim('worker-a'); simulate death: no heartbeat, no ack.
  // clock.advanceMs(leaseMs + 1); queue.reapExpired() → job back to pending.
  // workerB claims; run the orchestrator (in-memory harness) for the job's runId; ack with B.
  // then workerA attempts heartbeat/ack with its stale job copy → LeaseLostError, and
  // assert queue completed exactly once and orchestrator state shows single execution.
});

it('duplicate delivery of the same job does not duplicate artifact or commit', async () => {
  // run the SAME runId through runProject twice back-to-back (redelivery semantics).
  // assert: artifact revisions per step === 1, workspaces.commits length === expected single set,
  // executor startCounts unchanged on second delivery, event log has no duplicates (dedupeKey).
});
```

- [ ] **Step 1:** Write Group A tests → run → FAIL → make pass (harness config only; production code untouched). Commit `test(orchestrator): executor failure modes with fallback recovery`.
- [ ] **Step 2:** Group B → same cycle. Commit `test(orchestrator): late result after cancellation is never promoted`.
- [ ] **Step 3:** Group C (C1–C5) → same cycle. Commit `test(orchestrator): phase crash matrix with replay invariants`.
- [ ] **Step 4:** Group D → same cycle. Commit `test(orchestrator): dead worker recovery and duplicate delivery idempotency`.
- [ ] If any scenario exposes a genuine production bug: STOP, write the minimal failing reproduction as its own test, fix the root cause in the shared function all callers route through, commit separately as `fix(...)`, and note it for the PR body.

---

### Task 4: Wire-up, docs, evidence

**Files:**

- Modify: `docs/VALIDATION.md` (new dated section), possibly `docs/adr/0011-idempotent-step-reuse-and-run-controls.md` cross-reference — no new ADR (no new architecture decided; this generalizes ADR 0011's validation).

- [ ] **Step 1:** Run the whole suite 3× to shake out flakes: `npx vitest run packages/orchestrator/src/failure-injection.test.ts --pool=threads --maxWorkers=1` (repeat 3 times).
- [ ] **Step 2:** Run `npm run check` — all green; capture the summary output.
- [ ] **Step 3:** Add a "Failure injection suite — 2026-07-14" section to `docs/VALIDATION.md`: matrix table (phase × failure mode → covering test), the invariants asserted (single commit, single artifact revision, event dedupe, workspace restore, lease fencing), and the boundary statement (in-memory + temp-fs simulation; no real CLI processes were killed).
- [ ] **Step 4: Commit** — `docs: record failure injection matrix in validation record`
