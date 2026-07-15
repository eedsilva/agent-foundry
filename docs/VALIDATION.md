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
