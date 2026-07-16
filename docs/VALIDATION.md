# Validation record

Latest validation date: 2026-07-15.

This repository was validated from a clean dependency installation using the public npm registry.

## Completed checks

- `npm ci` completed from `package-lock.json`.
- `npm run typecheck` passed.
- `npm test` passed with 8 test files and 27 tests.
- All TypeScript packages, API and worker production builds passed.
- The Next.js production build passed when run directly for the web workspace.
- `npm run doctor` passed in mock mode.
- An HTTP smoke test created a project, ran the complete workflow and finished with:
  - project status `completed`;
  - 57 events;
  - 17 current artifacts;
  - all required planning, architecture, implementation, review, verification and decision-log artifacts;
  - valid `selected`, `attemptedModelIds` and `executed` route audit fields.

## Boundaries of this validation

Real-provider coverage is a one-run canary matrix, not a reliability or quality benchmark. It proves the three authenticated CLIs can execute the bounded scenarios and report a known model on this host at the recorded versions. It does not prove performance under concurrency, long-running repositories, provider outages, quota exhaustion or future CLI versions.

The final attempt to query npm's remote audit endpoint failed because DNS resolution for the registry was temporarily unavailable. Run `npm audit` in your own environment before a production deployment.

Docker Compose configuration is included, but Docker was not installed in the validation environment, so the image itself was not built here.

## Real provider canary baseline — 2026-07-14

The versioned v0.2 baseline invoked Codex, Claude Code and AGY independently for planning, greenfield implementation and repository repair. All nine runs passed. Planning produced no diff; every mutation scenario passed `node --test`, `git diff --check` and its exact file allowlist.

| Provider | CLI     | Selected model         | Executed model         | Scenarios  |
| -------- | ------- | ---------------------- | ---------------------- | ---------- |
| Codex    | 0.144.1 | `gpt-5.6-sol`          | `gpt-5.6-sol`          | 3/3 passed |
| Claude   | 2.1.208 | `sonnet`               | `claude-sonnet-5`      | 3/3 passed |
| AGY      | 1.1.2   | `Gemini 3.1 Pro (Low)` | `Gemini 3.1 Pro (Low)` | 3/3 passed |

Evidence:

- [`docs/baselines/v0.2-provider-canaries.json`](baselines/v0.2-provider-canaries.json) is the machine-readable source of truth.
- [`docs/baselines/v0.2-provider-canaries.md`](baselines/v0.2-provider-canaries.md) records versions, durations, usage where reported, aliases and limitations.
- Frozen evidence excludes raw provider output, authentication payloads, identities, credentials, session identifiers and machine-specific temporary paths.
- AGY is invoked with `--new-project` so each temporary repository is isolated from its cached project selection.

## Dogfood baseline — 2026-07-15

Where the canary invokes each CLI directly, the dogfood baseline runs five real v0.2 tasks **through the product pipeline** — `projectService.create`, the worker, the declarative workflow, routing, the quality loop and the deterministic verifier — and freezes the persisted route, usage, diff and verification of each run (ADR 0013). A task passes only when the run completes, the verifier approves and the diff stays inside the task's file allowlist. Records are append-only: a rerun appends a new attempt and never overwrites the prior one, and failures are frozen alongside passes rather than blocking the freeze.

Six records cover five tasks. `web-merge-events` carries a real failure -> root-cause fix -> rerun cycle: attempt 1 failed a whole-tree `git diff --check` that tripped on baseline `*.patch` files whose diff content legitimately ends in whitespace; the fix (`34da954`) silenced `*.patch` whitespace in the seeded workspace without weakening the verifier, and attempt 2 passed on the same class of diff.

| Task                      | Attempt | Status            | Executed model    | Duration | Human edits vs merged       |
| ------------------------- | ------: | ----------------- | ----------------- | -------- | --------------------------- |
| domain-redaction          |       1 | passed            | `codex-default`   | 6.4 min  | 1 same, 1 modified          |
| event-store-cursor        |       1 | passed            | `codex-default`   | 7.6 min  | 1 same, 1 modified          |
| executor-failure-fixtures |       1 | passed            | `codex-default`   | 6.4 min  | 1 agent-only                |
| failure-matrix-plan       |       1 | passed            | `claude-sonnet-5` | 34.7 min | n/a — plan task, empty diff |
| web-merge-events          |       1 | failed (harness)  | `codex-default`   | 6.2 min  | 1 modified                  |
| web-merge-events          |       2 | passed (post-fix) | `codex-default`   | 6.7 min  | 1 modified                  |

Human-edit annotation compares each agent output against the merged, human-reviewed sibling branch for its task (`agent/issue-10-sse-timeline` for the domain/persistence/web tasks, `agent/issue-11-failure-injection` for the fixtures task). `modified` and `agent-only` are expected, not defects: the merged #10 PR simplified `mergeEvents` with a fast path, and the merged #11 organized fixtures under `harness.ts` rather than the `testing/fixtures.ts` the agent created. `failure-matrix-plan` is a plan task that produced an empty code diff, so it has no per-file comparison and its record is annotated with a note.

### Boundaries of this baseline

This is an honest snapshot of the loop at a point in time, not a reliability or quality benchmark. It ran on a single host, one to two attempts per task (the second attempt exists only where a failure forced a rerun), against a single baseline ref (`8896a3c`). It does not prove behavior under concurrency, larger repositories, provider outages or quota exhaustion, and passing here is not a guarantee the agent's design matches what a human would merge — the human-edit column is exactly the evidence of that gap. It feeds the pre-adaptive-routing baseline: the routing feedback loop can later be measured against these durations, models and edit distances.

Evidence:

- [`docs/baselines/v0.2-dogfood.json`](baselines/v0.2-dogfood.json) is the machine-readable source of truth (six records, five tasks).
- [`docs/baselines/v0.2-dogfood.md`](baselines/v0.2-dogfood.md) renders the run table with per-run tokens, cost where reported, repairs and human-edit status.
- Frozen records are built through strict schemas that admit no stdout, stderr, credentials, identities or machine paths; the committed JSON carries only whitelisted fields.
- "Quota" in these records means tokens and estimated cost (ADR 0009); a subscription is not unlimited capacity.

## Personal Builder v1 roadmap alignment — 2026-07-13

The approved Personal Builder contract was encoded in repository documentation, `planning/roadmap-spec.json`, rendered planning output and live GitHub issues.

### Structural evidence

- Roadmap validation reports 16 milestones, 114 tasks and 131 managed issues.
- Twelve normative Personal v1 requirement groups map to milestones, task keys and Issue Radar release evidence.
- Validation rejects missing task references, empty evidence and milestones outside the transitive Personal v1 path.
- Personal v1 depends on Conversational Builder, Local Full-stack App Platform, Self-hosted Publish and Safe Runtime Foundation.
- Existing Repositories, Linux, browser code editing and Windows are explicitly post-v1.
- Live reconciliation reused 125 managed issues and created six: #138–#143.
- Live checks confirmed new sub-issue parents and the v1 blockers: v0.6, v0.10, v0.11 and v0.4.5.

### Verification performed

`npm run check` completed successfully after the final documentation and roadmap changes:

- Prettier format check passed.
- ESLint passed with zero warnings.
- Architecture validation found 11 workspaces with no forbidden edges or cycles.
- Roadmap and GitHub configuration validation passed.
- TypeScript project build passed.
- Vitest passed 9 files and 42 tests.
- Node script tests passed 23 tests, including the new Personal v1 traceability negative cases.
- All packages, API, worker and Next.js production application built successfully.
- `git diff --check` passed.

### Confidence statement

Planning coverage is above the requested 95% threshold because every normative capability group has structural issue coverage and named release evidence; the current structural coverage is 12/12. This is not a guarantee of implementation success. Delivery confidence must be earned incrementally by closing issues with the required evidence and finally passing the complete Issue Radar journey on clean macOS and Ubuntu LTS environments.

## Persisted workflow run domain — 2026-07-14

Issue #4 was validated from the isolated `agent/issue-4-workflow-run-domain` worktree after a clean `npm ci`. The final implementation persists independently versioned workflow runs, step runs, and attempts; exercises v0.1 project/job reads; and verifies successful, fallback, verifier, and coordinated-failure paths in the mock runtime.

Each required command was run separately against the final implementation:

- `npm run format:check` passed.
- `npm run lint` passed with zero warnings.
- `npm run architecture:check` passed for 11 workspaces and both architecture tests.
- `npm run roadmap:check` passed for 16 milestones, 114 tasks, 131 managed issues, eight roadmap/governance tests, GitHub configuration, and rendered-roadmap synchronization.
- `npm run typecheck` passed.
- `npm test` passed 16 Vitest files with 149 tests and 42 Node script tests.
- `npm run build` passed all eight packages, the API, the worker, and the Next.js production build.
- `git diff --check` passed.

Focused run-domain coverage includes seven contract tests, seven state-transition tests, six filesystem persistence/concurrency tests, and four mock-runtime integration tests. These verify timestamp and terminal-error invariants, every illegal state transition, compare-and-swap conflicts, legacy reads, attempt metadata/artifact linkage, fallback ordering, nested request context, and closure of the attempt/step/run hierarchy on failure.

## Failure injection suite — 2026-07-14

Issue #11 generalizes ADR 0011's validation into a systematic failure matrix over the orchestrator's execution pipeline. The suite lives in `packages/orchestrator/src/failure-injection.test.ts` on a shared harness (`packages/orchestrator/src/testing/harness.ts`); the dead-worker fixture lives in `packages/persistence/src/job-queue.test.ts` because the architecture rules forbid orchestrator→persistence imports.

### Matrix

| Phase / failure mode                                             | Covering test                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------- |
| Executor timeout, rate limit, invalid output (fallback recovers) | `failure-injection.test.ts` Group A                        |
| All routing candidates fail (valid terminal state, no-op replay) | `failure-injection.test.ts` Group A                        |
| Process kill: cancelled run leaves no commit or artifact         | `failure-injection.test.ts` Group B                        |
| Late result after cancellation never promoted                    | `packages/orchestrator/src/cancellation.test.ts`           |
| Crash before checkpoint                                          | `failure-injection.test.ts` Group C, C1/C2 (parameterized) |
| Crash after checkpoint, before execution                         | `failure-injection.test.ts` Group C, C1/C2 (parameterized) |
| Crash mid-execution (interrupted attempt finalized)              | `failure-injection.test.ts` Group C3                       |
| Crash after execution, before commit                             | `failure-injection.test.ts` Group C4                       |
| Crash after commit, before artifact put                          | `packages/orchestrator/src/run-controls.test.ts`           |
| Crash after artifact put, before attempt update                  | `packages/orchestrator/src/run-controls.test.ts`           |
| Crash before queue ack                                           | `packages/orchestrator/src/run-controls.test.ts`           |
| Redelivery of a completed run after ack                          | `failure-injection.test.ts` Group C5                       |
| Duplicate delivery of the same job                               | `failure-injection.test.ts` Group D                        |
| Dead worker: expired lease reaped, stale claimant fenced         | `packages/persistence/src/job-queue.test.ts`               |

C1 and C2 converge on the same persisted crash state because the checkpoint ref is only persisted on the attempt record; there is no reachable "checkpoint persisted, attempt not" state. They are expressed as one `it.each` over the two crash points.

### Invariants asserted

- Exactly one workspace commit per successful mutating step, across crash, replay, fallback, and redelivery.
- Exactly one artifact revision per step output after any replay.
- Lifecycle events are deduplicated: replay and redelivery add no events.
- The workspace is rolled back to the attempt's checkpoint before a fallback candidate runs and after a cancelled or killed attempt.
- Queue leases are fenced: a dead worker's stale lease can neither heartbeat nor ack (`LeaseLostError`), and the reclaiming worker receives a fresh fencing token.
- Terminal runs are replay no-ops: redelivering a completed or failed run changes no step runs, attempts, artifacts, events, or commits.

### Boundaries of this validation

All failures are simulated in-memory (scripted executor behaviors, fake workspaces, a power switch that aborts persistence writes) and on a temporary filesystem for the job queue. No real provider CLI processes were started or killed; crash and power-loss semantics are those of the fakes, which mirror the port contracts, not real git or real process trees.

### Verification performed

- The failure injection suite was run three consecutive times single-worker (`--pool=threads --maxWorkers=1`); all 16 tests passed on every run.

## Approval gates — 2026-07-15

Issue #13 adds `approval-gate` as a new `WorkflowNode` type that halts a run until a persisted
human decision, reusing the existing idempotent-replay and invalidation mechanisms from ADR 0010
and ADR 0011 rather than adding new control flow. See ADR 0012 for the design.

### Coverage

- `packages/contracts/src/workflow.test.ts` and `run.test.ts`: `ApprovalGateStep` schema
  constraints (`onReject`/`returnToStepId`/`repairArtifact`/timeout combinations), and the new
  `ApprovalRequest`/`ApprovalDecision` schemas.
- `packages/domain/src/run-state.test.ts`: the `awaiting_approval`/`rejected` transition graph.
- `packages/persistence/src/approval-repositories.test.ts`: create/get (plus list for requests)
  and duplicate-create rejection for both repositories; confirms neither exposes an `update`
  method.
- `packages/orchestrator/src/approval-gate.test.ts` (7 tests): approve advances to completion;
  reject with `onReject: 'end'` terminates the run as `rejected`; reject-with-return-to-step and
  request-changes rewind the repair step and re-halt with a fresh approval request; a simulated
  worker restart before any decision produces no duplicate `ApprovalRequest`; a simulated crash
  between recording a decision and requeuing recovers using the originally recorded decision
  without duplicating side effects; deciding a disallowed action is rejected.
- A manual HTTP smoke test against the mock runtime (`POST /projects`, `GET
/runs/:runId/approvals`, `POST /runs/:runId/approvals/:requestId/decide`) exercised both the
  approve path (`awaiting_approval -> queued -> completed`) and the reject path
  (`awaiting_approval -> queued -> rejected`) against the real file-backed persistence layer.

### Verification performed

- `npm run typecheck` passed across the full workspace.
- `npm test` passed: 34 test files, 275 tests (up from the 8 files / 27 tests recorded above,
  reflecting all orchestrator features shipped since).
- `npm run build` passed for all TypeScript packages, the API, the worker, and the Next.js web
  production build.
- `npm run doctor` passed in mock mode.
- `npm run check` completed successfully: Prettier, ESLint with zero warnings, architecture and roadmap validation, TypeScript, Vitest with 26 files and 217 tests, 42 Node script tests, and all package, API, worker, and Next.js production builds.

## Approval review API and UI — 2026-07-15

Issue #14 builds on the approval-gate domain model from #13 (ADR 0012): a review UI on the
project page, and two API-level fixes the acceptance criteria required — `request-changes` now
rejects a missing comment, and a genuinely conflicting decision (two different actions recorded
or raced for the same approval request) now returns `409` with the settled decision instead of
either silently succeeding with the wrong action or falling through to a generic `500`. See the
"Decision update" section appended to ADR 0012 for the conflict-resolution rule.

### Coverage

- `packages/contracts/src/api.test.ts` (new): `DecideApprovalRequestSchema` rejects
  `request-changes` without a `note`, accepts it with one, and leaves `approve`/`reject`
  unaffected.
- `packages/orchestrator/src/approval-gate.test.ts` (2 new cases, 9 total): a second
  `decideApproval` call with a different `action` after the run already moved on throws
  `ApprovalConflictError` carrying the settled decision; a genuinely concurrent
  `Promise.allSettled` pair of conflicting `decideApproval` calls on the same request resolves to
  exactly one success and one `ApprovalConflictError`. The existing approve/reject tests also now
  assert the project-level status (not just the run's), which is what caught the bug below.
- `apps/api/src/approvals.test.ts` (new, 5 tests): end-to-end HTTP coverage against a
  self-contained fixture workflow (an architecture-review gate and a release-review gate) loaded
  via a `WORKFLOWS_DIR` override — approve through both gates to completion; reject at the release
  gate ends the run as `rejected`; `request-changes` without a note is `400`; `request-changes`
  rewinds the architecture step, writes the repair artifact, and re-halts with a fresh request; a
  genuine two-caller race on one request returns one `202` and one `409` with the settled
  decision.
- Manual browser walkthrough against a live dev server (isolated `DATA_DIR`/`WORKFLOWS_DIR`, mock
  executor) driving the same shape of fixture workflow through the actual UI: opened the pending
  architecture-approval artifact, submitted `request-changes` with a comment (the required-comment
  validation and the downstream-rewind preview text both matched the API's behavior), confirmed
  the rewound run re-halted with a fresh request while the prior one displayed its recorded
  decision, compared revisions via the diff toggle, approved through to the release gate,
  confirmed the `VerificationReport` artifact rendered as a pass/fail checklist instead of raw
  JSON, and rejected the release gate to inspect the terminal-state UI.

### Bug found during the manual walkthrough

`WorkflowOrchestrator`'s `projectStatusForRun` (added by #13) never mapped the run statuses
`awaiting_approval` or `rejected` to the matching `Project` statuses — it silently fell back to
`running` for both. No existing test caught it because none asserted `project.status`, only
`run.status`. The project record (and therefore the web UI's header pill and its polling loop,
which stops once the project is "terminal") was wrong for the entire duration of every approval
wait and after every rejection. Fixed in `workflow-orchestrator.ts`; regression assertions added
to the two affected `approval-gate.test.ts` cases.

### Verification performed

- `npm run typecheck`, `npm run lint:code`, `npm run format:check`, and `npm run architecture:check`
  all passed across the full workspace.
- `npm run test:unit` passed: 36 files, 285 tests.
- `npm run build` passed for all TypeScript packages, the API, the worker, and the Next.js web
  production build.
- `/ponytail:ponytail-review` flagged one finding (a hand-rolled `VerificationReport` duck-type
  check reinventing the already-exported `VerificationReportSchema`); applied before opening the PR.

## Actor-aware feedback audit — 2026-07-16

Issue #17 adds typed actor identity, redacted persisted feedback, exact retry/prompt provenance,
filesystem reconstruction, and a deterministic run audit export (ADR 0015).

Compatibility is new-reader/old-data only. Before an upgrade, snapshot `DATA_DIR`; a downgrade
requires stopping all workers and restoring that pre-upgrade snapshot before starting the older
binary, because its strict schemas cannot read new `actor` or `feedbackArtifact` fields.

Focused TDD evidence:

- Contract/redaction RED failed because `ActorRefSchema`, `FeedbackArtifactSchema`,
  `RunAuditExportSchema`, typed approval actors, and `redactUnknown` did not exist; GREEN passed 3
  files / 26 tests.
- Persistence/orchestrator/API RED failed on missing feedback metadata, retry linkage, prompt hash,
  typed actor normalization, and audit route; GREEN passed 4 files / 16 tests.
- `npm run typecheck` passed after the focused suites.

The final validation commands are `npm run check`, `npm run doctor`, and `git diff --check`.

## Emergency ceiling and model overrides — 2026-07-16

Issue #16 adds immutable audited run/step/retry model pins, policy-safe explicit routing, and a
restart-safe emergency ceiling (ADR 0016). Legacy `maxAttempts` and `maxIterations` still parse but
do not bound normal execution.

### TDD and deterministic trace

- Contract RED: `packages/contracts/src/api.test.ts` exposed that the parsed override response
  adds the compatibility default `sequence: 1`; the expected fixture omitted it. GREEN was the
  one-field expectation fix. The focused contract run passed 1 file / 10 tests.
- Ceiling/Git focus: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts
packages/persistence/src/workspace-manager.test.ts --pool=threads --maxWorkers=1
--reporter=verbose` passed 2 files / 30 tests. The workspace cases use real temporary Git
  repositories; the orchestration cases cover restart and cancellation races.

The deterministic fixture trace asserted by those suites is:

```text
lastVerifiedCheckpoint=initial-head
-> failed tree captured at draft/run-1
-> active HEAD restored to initial-head; worktree clean
-> run.status=failed; run.error.code=EMERGENCY_CEILING
-> run.execution.ceiling.draftBranch=draft/run-1
-> count(run.emergency_ceiling_reached)=1 after redelivery
```

Boundary coverage also proves `14_399_999ms` continues, `14_400_000ms` ceilings, the tenth
completed repair ceilings, approval resets the repair count, persisted pause/approval wait is
excluded, persisted `running` time across restart is counted fail-safe, and cancellation wins
ceiling races. Override-focused suites cover all actor kinds through `ActorRef`, immutable sequence
ordering across restart/concurrency, retry > step > run precedence, fallback suppression, catalog
drift, exact selection between duplicate provider/model tuples, rejection of non-agent retry pins,
and every unchanged hard routing constraint. Legacy retry tuples without `modelId` resolve only
when one enabled catalog entry matches; ambiguous tuples fail closed.

### Security, compatibility, migration, and rollback

- Audit inputs are required on new writes and redacted before persistence. Explicit pins cannot
  add permissions or bypass policy, provider, context, enabled-model, or workspace-write checks.
- Existing runs without `execution`, retry directives without audit fields, and workflows with
  legacy budgets remain readable. There is no backfill.
- Upgrade requires a stopped-worker snapshot of `DATA_DIR` and generated Git workspaces. For
  downgrade, preserve required draft refs, stop workers, restore that snapshot, then start the old
  version; do not mix versions or perform code-only rollback.
- Draft replay and deletion fail closed on ownership/ref drift. Evidence must not include raw
  provider output, run files, secrets, or draft contents.

### Definition of Done mapping

- **Behavior:** focused tests demonstrate pins, exact thresholds, repair reset, cancellation,
  restart convergence, draft preservation, and verified restoration.
- **Engineering:** contract, persistence, routing, orchestration, API, and native web helper tests
  cover the new contracts and failure modes; full format/lint/architecture/type/test/build results
  are recorded below.
- **Safety and operations:** ADR 0016 and `OPERATIONS.md` document redaction, hard constraints,
  fail-closed draft ownership, recovery, compatibility, migration, containment, and rollback.
- **Delivery evidence:** this section supplies the trace and command results; the rendered UI
  captures are `output/playwright/issue-16/issue-16-model-pins-ceiling.png` and
  `output/playwright/issue-16/issue-16-retry-pin.png`; the PR must link issue #16 and include the
  clean review results.

### Full verification

The first `npm run check` stopped at `format:check` because three transient Playwright CLI page
snapshots created during the concurrent evidence capture were unformatted. They contained no
product source and were removed after capture. The clean rerun passed:

- Prettier and ESLint passed with zero warnings.
- Architecture validation passed for 11 workspaces with no forbidden edges or cycles; its 2 script
  tests passed.
- Roadmap validation passed for 16 milestones, 114 tasks, and 131 managed issues; its 8 tests,
  GitHub configuration check, and rendered-roadmap synchronization passed.
- TypeScript project references passed.
- Vitest passed 48 files / 422 tests; Node script tests passed 42 / 42.
- All eight packages, the API, the worker, and the Next.js production application built.

`npm run doctor` passed in mock mode with Node 22.22.3, Git 2.50.1, the harness/workflow/catalog,
and Codex, Claude, and AGY reported ready. `git diff --check` passed.

The two 1440×1537 browser captures above were visually inspected. The first shows the failed
`EMERGENCY_CEILING` state, 10 repairs, `draft/run-16`, the deduplicated ceiling event, and native
run/step pin fields. The second shows the native retry-pin modal with required runtime model,
actor, reason, and estimated-impact controls. They contain deterministic fixture data and no user
or credential data.

An independent whole-branch correctness review approved the final implementation with no open
findings after fixes for terminal lifecycle races, exact duplicate-model identity, legacy retry
identity resolution, and the exact post-stop four-hour boundary. Its focused regression run passed
8 files / 94 tests.

The post-PR Ponytail review found one actionable duplication: the run/step and retry pin forms
repeated the same model, actor, reason, and estimated-impact fields. The code-simplifier extracted
one local `ModelPinFields` component and shared actor-kind list while preserving field names,
validation, defaults, styling, submission, and async behavior (net -27 lines). Its focused
verification passed 12 / 12 tests, root typecheck, the web production build, page ESLint, Prettier,
and `git diff --check`. The second Ponytail pass returned `Lean already. Ship.` with no further
complexity findings.
