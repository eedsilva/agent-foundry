# ADR 0047: Each task asserts its acceptance check in a browser

- Status: Accepted
- Date: 2026-07-29
- Owners: Core
- Builds on ADR 0043 (`for-each-task`) and ADR 0045 (per-task deterministic verification)

## Context

ADR 0045 gated every task on the compiler, the linter, the tests, an applied migration and a booting
preview. All of those answer "does it build and start", none answers "does it work". A sign-in page
that renders and compiles can still reject valid credentials.

The machinery to answer it already exists and has since #32: `playwright` in `packages/executors`,
`browser-verifier.ts`, and the declarative `browser-test.plan` contract wired through `contracts` →
`persistence` → `workflow-orchestrator`. It ran **once, at the very end** of the pipeline, so a
broken journey in task 1 surfaced after task 14 and cost the whole run.

The task graph already carries the claim to assert: #321 gave every task an `acceptanceCheck`.

## Decision

- `for-each-task` gains an optional `browser: { plan, check }`. `plan` is an agent step that turns
  the task's `acceptanceCheck` into a declarative `browser-test.plan`; `check` is the existing
  `verify` step with `browserTestPlanArtifact`, which is to say the existing Playwright runner. The
  contract enforces that `check` reads exactly the artifact `plan` writes, and that `plan` cannot
  mutate the workspace.
- `browser` requires `verify` (and therefore `repair`). The assertion boots a preview, and a preview
  of code that does not compile tells you nothing — so it runs **after** the deterministic gate is
  green, never instead of it.
- A failed assertion invokes repair with the plan **and** the report pinned into its inputs. The
  report carries the failing step, its error and its screenshot/trace references, so the fixer works
  from evidence rather than a summary. The plan is pinned unchanged for the rerun, matching what the
  pipeline-tail browser loop already did.
- **Repair for a failed assertion is its own step**, `<repair>-browser.<taskId>`. Reusing the
  deterministic gate's per-task repair id would collide on step identity — both loops run for the
  same task and would share iteration numbers — and a timeline that distinguishes "the checks were
  red" from "the feature did not work" is worth more than one that does not. Its `inputArtifacts`
  are the declared repair's plus the plan and the report.
- **A plan that is neither a valid plan nor a refusal fails the task outright.** Repairing the code
  cannot fix a malformed plan, and the plan is pinned unchanged for every rerun — retrying would
  burn the whole repair budget, with workspace-mutating steps, on something unfixable by
  construction.
- **A browser repair re-runs the deterministic gate.** It edited the workspace after the checks went
  green, so they are no longer known to be; without this a task could complete on a red typecheck,
  which is the one thing ADR 0045 promises cannot happen. The second pass carries an iteration
  offset so its step identities stay distinct from the first's.
- **A green assertion resets the consecutive-repair counter**, exactly as the deterministic gate
  does. Without it, one browser repair per task marches a long graph into the consecutive-repairs
  emergency ceiling even though no streak ever occurred.
- **A task with no user-visible surface says so.** The plan step is instructed to return
  `status: "blocked"` with a one-line reason when there is nothing to assert — a migration, a config
  change, a pure refactor. That emits `quality.approved` with `asserted: false` and the task
  completes normally. It is an answer, not a failure.
- Cross-tenant denial is expressible with no new machinery: a task whose acceptance check says
  "user A cannot see user B's issues" gets a plan that signs in as one account and asserts the
  other's rows are absent, run against real RLS through the JWT-forwarding gateway (ADR 0038). The
  `web-app-v1` plan step's instructions say so explicitly.

## Consequences

- `workflowUsesBrowserPlan` now looks inside `for-each-task.browser.check`, so the per-task plan
  agent gets the browser-plan output schema the pipeline-tail one already got.
- The per-task plan and the browser repair are pinnable per task, like `implement` and `repair`.
- Every task in a graph now boots a preview and drives a browser. That is slow and deliberately so:
  it is what makes "the feature works" a fact rather than a claim. The pipeline-tail
  `browser-verification` node still runs; collapsing it is #329.
- `MockAgentExecutor` already emits a valid browser plan for any step given the browser-plan schema,
  so mock runs exercise the loop. The composition seam stubs the **coordinator**, not the Playwright
  verifier — mock mode swaps in an auto-approving coordinator, so stubbing the verifier under it
  would never be consulted and every assertion would silently pass.
- A stubbed report must announce its preview session through the coordinator's `onSessionStarted`
  callback; the orchestrator binds the report to that session and rejects an unsourced one.
- `browserRepairId` lives in `packages/domain/task-graph.ts` beside `taskStepId`/`isTaskStepId`: it
  is the same per-task step-id vocabulary, and both the orchestrator and `ProjectService` read it.
- Browser verdicts do **not** feed `recordQualityOutcome` / `recordDeterministic` / the decision log.
  Those stay the deterministic gate's telemetry, so a model's score is not moved by a journey a
  different step planned. Revisit if per-task routing data ever needs the browser outcome.
- **Not covered by a test:** cross-tenant denial passing end to end. It is expressible today — the
  `hidden` assertion and the JWT-forwarding path both pre-date this change — but proving it needs a
  fixture seeding a second tenant's rows, and `BrowserActionSchema` has no sign-out or context
  switch, so one plan runs in one session. Worth a follow-up.
- Evidence reaches repair as artifact references (name/revision/sha), not as openable paths, so a
  fixer cannot actually view a screenshot. That limitation pre-dates this change and applies equally
  to the pipeline-tail node.
