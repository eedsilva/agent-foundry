# Plan — #578: tracer must drain approved runs to a terminal status

## Spec

GitHub issue #578 (child of #564). Reproduced on the 2026-08-17 real sweep:
`crud-heavy` run `01M06SASP0EEJ36TS703CQZ8NZ` was auto-approved and requeued, but
`runTracerScenarioToCompletion()` returned as soon as a single
`worker.runOnce()` returned `false`. The run stayed `queued`, job
`run-project-…-approval-…` stayed pending, and no evidence bundle existed.

Root cause: `WorkerLoop.runOnce()` returns `false` whenever `queue.claim()` finds
nothing *claimable right now*. `FileJobQueue.claim()` skips any pending job whose
`availableAt` is in the future — which is exactly what `nack()` produces
(`nextBackoffMs`: 2s, 4s, … capped at 30s). A transient miss is not a terminal
state, but the driver treated it as one. The `--approve-gates` contract promises
to drive the run to a terminal status.

Second defect: `evaluateGoldenJourneyGate` attributes *every* missing bundle to
mock mode, including a real run that was cut short like the one above.

## Global Constraints

- No new dependencies. No new CLI flags. Shortest diff that fixes both defects.
- Regression tests must be deterministic and must not touch a real provider,
  a real browser, or the network. `EXECUTOR_MODE=mock` runtime tests are fine;
  the new drain-loop test must use fakes, not a runtime.
- Terminal status comes from `isWorkflowRunStatusTerminal` in
  `@agent-foundry/contracts` — do not re-list the statuses.
- Existing exported behaviour of `runTracerScenario` (single step, parks at the
  gate) is unchanged. Only the `ToCompletion` driver changes.
- Repo style: comments explain *why* (issue number + the failure they pin),
  never *what*. Match the density already in `tracer.ts`.
- `exactOptionalPropertyTypes` is on: build optional fields with
  `...(x ? { x } : {})`, never `x: undefined`.

## Task 1 — drain the run to a terminal status

Files: `packages/composition/src/tracer.ts`, `packages/composition/src/tracer.test.ts`.

TDD. Write the failing tests first, run them, paste the red output in the report,
then implement.

### Behaviour to build

Export a drain loop from `tracer.ts` so it is unit-testable with fakes:

```ts
export interface DrainRunTarget {
  worker: { runOnce(): Promise<boolean> };
  runs: { get(runId: string): Promise<{ status: WorkflowRunStatus } | undefined | null> };
  projectService: {
    listApprovals(runId: string): Promise<readonly { request: { id: string }; decision?: unknown }[]>;
    decideApproval(
      runId: string,
      requestId: string,
      input: { action: 'approve'; decidedBy: string },
    ): Promise<unknown>;
  };
}

export interface DrainRunOptions {
  /** How long to keep polling while nothing is claimable. Default 120_000. */
  idleTimeoutMs?: number;
  /** Wait between polls once a claim missed. Default 1_000. */
  pollIntervalMs?: number;
}

export async function drainRunToTerminalStatus(
  target: DrainRunTarget,
  runId: string,
  options?: DrainRunOptions,
): Promise<string>;
```

The narrow structural types above are deliberate: the real `Runtime` satisfies
them, and a test fake can implement them without constructing a runtime. Pick
exact member shapes that compile against the real `Runtime` — adjust the sketch
if `listApprovals`/`decideApproval`'s real signatures differ, but keep the
parameter structural (never `Runtime` itself).

Loop, per iteration:

1. Read the run. If it exists and `isWorkflowRunStatusTerminal(run.status)`,
   return that status.
2. Find the first approval entry with no `decision`; if there is one, approve it
   with `decidedBy: 'tracer-driver'` (unchanged from today).
3. `await worker.runOnce()`. If it returned `true`, work happened — reset the
   idle deadline and continue immediately.
4. It returned `false`: if the idle deadline has passed, throw a diagnostic
   error; otherwise sleep `pollIntervalMs` and continue.

The idle deadline is `Date.now() + idleTimeoutMs`, reset on every `true`. Default
120_000 is chosen so it clears the queue's 30s max backoff several times over.

The thrown error must name, in one message: the run id, the last observed run
status, how many approval requests are still undecided, the idle timeout that
expired, and that a pending job may still be in queue backoff. It is caught
per-scenario by `scripts/tracer.ts`, so its text becomes the scenario's verdict
reason — make it diagnosable without a debugger.

Rewire `runTracerScenarioToCompletion` to call it, keeping its current return
shape (`projectId`, `runId`, `runStatus`, `evidence`). Delete the old
`for (;;)` approve/`runOnce` loop — the drain loop replaces it entirely,
including the initial bare `runOnce()`.

### Tests (all in `tracer.test.ts`)

Fake-driven unit tests around `drainRunToTerminalStatus`, no runtime, no temp
dir. Build one small fake whose `runOnce()` returns a scripted sequence.

1. **The regression test (must fail before the fix).** Script: the run parks at
   an approval (`awaiting_approval`, one undecided request), the driver approves
   it, the *first* `runOnce()` after the approval returns `false` (job not yet
   claimable), the next returns `true` and moves the run to `completed`. Assert
   the returned status is `completed` and that the fake recorded no undecided
   approval left. Use `pollIntervalMs: 0` so it is instant. Note in a comment
   that today's code returns with the run still `queued` here.
2. **Idle timeout.** `runOnce()` always `false`, run stuck `queued`,
   `idleTimeoutMs: 0`, `pollIntervalMs: 0` → rejects with a message containing
   the run id and `queued`.
3. **Multiple gates.** Two successive approvals, each followed by one `false`
   then one `true`, ending `completed` → both approved exactly once.
4. Keep the two existing mock-mode `runTracerScenarioToCompletion` tests green
   (they still assert `completed` / `evidence === null`).

Verify: `npx vitest run packages/composition/src/tracer.test.ts` and
`npx tsc -b packages/composition` (or the repo's typecheck for that package).

## Task 2 — a missing bundle on an unfinished run must not blame mock mode

Files: `packages/composition/src/golden-journey-gate.ts` and its test file
(`golden-journey-gate.test.ts` — create the case in whichever test file already
covers `evaluateGoldenJourneyGate`).

TDD, same discipline: failing test first.

`evaluateGoldenJourneyGate`'s `evidence === null` branch currently always reasons
`'no validation-evidence bundle was published for the run (mock mode publishes none)'`.
Split it on `isWorkflowRunStatusTerminal(input.runStatus)`:

- run status is **not** terminal (e.g. `queued`, `awaiting_approval`, `running`)
  → a neutral reason that says the run never reached a terminal status and names
  the status, with no mock-mode claim.
- run status **is** terminal (or unparseable/`unknown`) → keep today's wording.

`runStatus` is typed `string` on `GoldenJourneyGateInput`, so guard the
`isWorkflowRunStatusTerminal` call with `WorkflowRunStatusSchema.safeParse`
(or the equivalent already used in this package) rather than casting.

Tests: one case per branch — a `queued` run with `evidence: null` yields
`no-evidence` with a reason that does **not** mention mock mode and does mention
`queued`; a `completed` run with `evidence: null` keeps the existing wording.
Existing gate tests must stay green.

Verify: `npx vitest run` on the gate's test file, plus the package typecheck.

## Out of scope

- Shutting down previews on failed runs (sibling ticket).
- The `exit 137` provisioning failure.
- Any change to `WorkerLoop`, `FileJobQueue`, or the approval requeue path.
