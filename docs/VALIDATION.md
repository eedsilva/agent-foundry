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

## Declarative browser verification — 2026-07-17

Issue #32 adds a Chromium-backed quality loop without changing the existing workspace-verification
path. The browser plan and report contracts are version 1; the report is JSON-only, redacts preview
tokens, caps observations at 100, and links its plan by immutable artifact reference. Browser mode
requires a plan artifact and disables workspace scripts and `git diff --check`; a failed report is
given to repair together with the exact initial plan revision before the same plan reruns.

Focused acceptance evidence passed: 8 files / 131 tests. The adjacent run-control, approval, browser
coordination, and policy-release regression command passed 4 files / 47 tests.

```bash
npx vitest run \
  packages/contracts/src/preview.test.ts \
  packages/contracts/src/policy.test.ts \
  packages/contracts/src/workflow.test.ts \
  packages/persistence/src/workflow-repository.test.ts \
  packages/executors/src/browser-verifier.test.ts \
  packages/orchestrator/src/browser-verification-coordinator.test.ts \
  packages/orchestrator/src/policy-release-e2e.test.ts \
  packages/composition/src/runtime.integration.test.ts
```

The coverage includes plan/schema rejection, exact origin policy, no mixed browser/workspace
verification, persisted workflow validation, preview start/stop coordination, failure -> repair ->
same-plan rerun, composition wiring, real Chromium CRUD, exact semantic locators, step-fatal passive
failures, token redaction, request and WebSocket policy blocks, diagnostics, observation cap, timeout
cleanup, and cancellation cleanup.

The preview origin is always constrained to the exact `/preview/<sessionId>/` prefix, even if that
origin is also present in `browserAllowedOrigins`. Contracts and the executor share one path
validator: it rejects literal or encoded traversal, encoded network paths, backslashes, controls,
and nested percent encoding, then rechecks each decoded layer before navigation. The executor also
verifies the resolved URL against the exact prefix.

Executor-owned initialization tracks one-shot `setTimeout` callbacks, including native string
handlers, on every open page. A step waits for pending requests, popups, and tracked timers to drain,
so console errors and uncaught exceptions scheduled up to and including 1,000 ms are attributed to
their initiating step before a later side effect can run. The executor never evaluates a string
handler itself; Chromium runs the original handler and a companion native timer marks completion.
Intervals, animation-frame callbacks, and one-shot timers over 1,000 ms are deliberately not awaited
because waiting for application long polling would make verification unbounded. Those signals may
fall outside deterministic step attribution; the 10-second Playwright/pending-work bounds and
60-second whole-run ceiling remain authoritative.

The provider-facing draft-2020-12 schema carries the path pattern and `prefixItems` first-`goto`
constraint. JSON Schema cannot express uniqueness by one property of array objects, so a namespaced
`x-agent-foundry-runtime-validation.uniqueStepIds` extension documents that
`BrowserTestPlanArtifactSchema` performs the authoritative duplicate-id check. Invalid provider
output becomes a versioned failed report rather than reaching Chromium.

Install Chromium locally with `npx playwright install chromium`. CI installs the same browser with
`npx playwright install --with-deps chromium` before `npm test`. The issue #32 branch gate is:

```bash
npm run format:check
npm run lint
npm run architecture:check
npm run roadmap:check
npm run typecheck
npm test
npm run build
npm run doctor
git diff --check
```

Migration is compatibility-on-read: missing `browserAllowedOrigins` keeps the policy to the trusted
preview prefix, and missing `browserTestPlanArtifact` retains workspace verification. No backfill is
needed. Rollback removes the browser quality-loop node and runtime wiring while workspace
verification remains available. This does not add binary screenshots/traces (issue #33) or strong
process/network isolation (issue #120).

## Durable preview lifecycle — 2026-07-16

Issue #31 replaces process-local preview state with versioned files and adds API-owned health/reaping plus redacted cursor logs. Evidence is split by boundary:

- `packages/contracts/src/preview.test.ts` validates durable sessions, structured log pages, and failure diagnostics.
- `packages/persistence/src/preview-repositories.test.ts` validates optimistic updates, digest-only token storage, designated free-text redaction without changing recovery-critical structure, pagination/truncation, and dead/malformed repository-lock recovery without stealing live-owner locks.
- `packages/executors/src/node-preview-runner.test.ts` validates HTTP health, persisted stdout/stderr, independent crash detection, restart, process-tree termination, and unconditional tracked-session cleanup after each test.
- `packages/orchestrator/src/preview-service.test.ts` validates startup windows, health thresholds, bounded restarts, TTL/orphan reaping, concurrent lifecycle calls, deduplicated events/artifacts, and redacted failure diagnostics containing the retained 200-entry log tail.
- `packages/composition/src/config.test.ts` pins all eight preview lifecycle defaults and overrides.
- `apps/api/src/preview.test.ts` validates start/stop compatibility, current-run association, canonical cursor/limit validation, project ownership, access-log token redaction, and absence of scheduler registration in generic app construction.
- `apps/api/src/preview-reaper.test.ts` validates the immediate startup sweep, non-overlapping reap ticks, aggregate-error logging, idempotent timer cleanup, and direct Fastify close waiting for a caught active rejected sweep.

The storage boundary is `DATA_DIR/previews/<sessionId>/`; raw access tokens are excluded from it and from access logs. The log API returns only entries belonging to a session owned by the path project, with canonical decimal `cursor >= 0` and `1 <= limit <= 200`. The singleton API entrypoint owns the only scheduler; generic app instances and worker processes do not run preview sweeps.

Migration coverage intentionally has no legacy fixture because the previous implementation persisted no preview sessions. Operational evidence requires stopping old preview processes before upgrade. Rollback/recovery and the same-host PID-lock assumption are recorded in `OPERATIONS.md` and ADR 0018.

## Persistent conversation domain — 2026-07-17

Issue #36 adds one lazy canonical conversation per project with ordered messages, project-scoped attachment metadata, idempotent operation records, persisted SSE replay, and a schema-version-1 project export. The implementation deliberately excludes attachment blobs/UI (#43), conversation classification (#38), and operation execution lifecycle (#39).

Deterministic evidence is split by boundary:

- `packages/contracts/src/conversation.test.ts` and `packages/contracts/src/api.test.ts` validate roles, content variants, operation kinds/links, canonical `conversation.id === projectId`, project-scoped attachment access, bare lowercased MIME types, create requests, pages, and exports.
- `packages/persistence/src/fs-utils.test.ts` validates that path existence returns false only for `ENOENT` and rethrows deterministic `ENOTDIR` corruption.
- `packages/persistence/src/conversation-repository.test.ts` validates malformed and cross-paired persisted-conversation rejection, filesystem reconstruction, corrupt-path failure instead of empty legacy state, concurrent contiguous sequence assignment, stable exclusive cursors, write-time redaction, recoverable locking, interrupted atomic replacement with harmless orphan temp state, a coherent aggregate snapshot against a blocked writer, legacy snapshot reads without directory creation, and same/different-input operation idempotency semantics.
- `packages/orchestrator/src/conversation-service.test.ts` validates lazy read without migration/write, cross-project attachment rejection, missing-run and artifact-hash mismatch rejection, paging, and export through the repository snapshot with operation-to-message referential consistency. `packages/composition/src/runtime.integration.test.ts` additionally proves export rejects a canonical conversation stored under another project and deterministic `ENOTDIR` conversation storage.
- `apps/api/src/conversation.test.ts` validates routes, empty message text and negative cursor rejection, parameterized attachment media-type rejection, cross-project attachment denial, concurrent retries, `409` conflicts, redacted disk/export data, query-over-header SSE precedence, restart replay without duplicates, and replay beyond the 500-message poll batch.
- `apps/api/src/events-stream.test.ts` remains green, proving the shared SSE helper preserves the existing project-event stream.

The persisted layout is `DATA_DIR/projects/<projectId>/conversation/{conversation.json,messages.jsonl,attachments.jsonl,operations.jsonl}`. JSONL records are logically append-only but physically published by atomic complete-file replacement under the conversation lock. Message sequences are positive. HTTP and SSE cursors are exclusive nonnegative sequence numbers; cursor `0` starts at the first message, and `?cursor=` wins over `Last-Event-ID`. Export reads one lock-protected aggregate snapshot. Existing projects derive their conversation on reads and exports, then persist it on the first conversation write without backfill or read-time directory creation.

Project scoping is an aggregate integrity check, not caller authentication. Attachment records contain only client-declared metadata with bare MIME `type/subtype`; no blob is stored or inspected. Redaction is best-effort and occurs before writing message text/data and attachment names, so tests assert both exported and raw persisted records exclude their seeded secret values.

Full-gate results on this branch:

- `npm run check` passed Prettier, ESLint, the 11-workspace architecture check and its two tests, roadmap validation for 16 milestones / 114 tasks / 131 managed issues plus eight roadmap/governance tests, TypeScript, 64 Vitest files / 605 tests, 42 Node script tests, all eight package builds, API, worker, and the Next.js production build.
- `npm run doctor` passed in mock mode.
- `git diff --check` passed.

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

## Approval gates, policy and emergency-ceiling E2E — 2026-07-16

Issue #18 (`v03-policy-e2e`) closes the v0.3 "Human Control" milestone by proving its four acceptance
criteria against the real orchestrator and API, not just their individual unit suites. Criteria 1 and 2
were already fully proven end-to-end when `v03-approval-api-ui` (#158) shipped; criteria 3 and 4 had no
composed test and are covered by one new fixture added for this issue.

### Matrix

| Acceptance criterion                                                          | Covering test                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run pauses at an approval gate, receives `request-changes`, and resumes       | `apps/api/src/approvals.test.ts` — `'request-changes rewinds to the architecture step, writes a repair artifact, and re-halts'`                                                                                                                                  |
| Two concurrent decisions on one approval never both take effect               | `apps/api/src/approvals.test.ts` — `'returns 409 with the settled decision when two differing decisions race'`; `packages/orchestrator/src/approval-gate.test.ts` — `'conflicts (#14) a genuinely simultaneous pair of differing decisions: one wins, one 409s'` |
| A policy violation blocks the release even though a reviewer approved         | `packages/orchestrator/src/policy-release-e2e.test.ts` — `'blocks the release after the LLM reviewer approves when deterministic policy verification never passes, and the emergency ceiling preserves resumable state'`                                         |
| The emergency ceiling stops a pathological loop and preserves resumable state | same test as above (`policy-release-e2e.test.ts`); unit-level ceiling mechanics already covered by `packages/orchestrator/src/emergency-ceiling.test.ts`                                                                                                         |

### Composed scenario

`policy-release-e2e.test.ts` chains two `quality-loop` nodes: an LLM code-review gate that approves on
its first iteration (proving a reviewer said yes), followed by a deterministic verification gate wired
to a `ProjectPolicy` with a forbidden dependency. A bare `verify` node is advisory only and never blocks
a run; only a `quality-loop`'s repair cycle can, and that cycle is unbounded in code except for the
emergency ceiling. With verification fixed to never approve, the run loops through 10 consecutive
repairs and the ceiling fires: the run fails with `EmergencyCeilingError`, a draft branch preserves the
unmerged work, and `lastVerifiedCheckpoint` stays at the last good state — proving both that policy
blocks the release despite the earlier approval, and that the budget ceiling prevents an infinite loop
while leaving the run in a resumable state. A control test with the same fixture and a policy-satisfying
verification result completes normally, ruling out a fixture bug as the cause of the block.

### Boundaries of this coverage

These are orchestrator-level tests against the harness's fake `VerificationService` (`opts.verification`),
consistent with every other test in this directory — `packages/orchestrator` cannot import the real
`WorkspaceVerifier` (architecture boundary). The real `forbiddenDependencies` check logic is unit-tested
separately in `packages/executors/src/verifier.test.ts`. Web UI coverage for approvals and the emergency
ceiling already exists as Playwright evidence from issues #14 and #16; no new UI work was needed here.

## ProjectVersion ledger — 2026-07-17

Issue #40 (`v06-version-history`) adds an explicit, immutable `ProjectVersion` ledger over the existing
git checkpoint/commit primitives (ADR 0021): list, compare, revert, and branch from any recorded version
without ever rewriting history.

### Matrix

| Acceptance criterion                                    | Covering test                                                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ProjectVersion points at commit, run, and artifacts     | `packages/contracts/src/project-version.test.ts`; `packages/orchestrator/src/project-version-service.test.ts` — `recordFromStep` cases                                                     |
| Each mutating step commit creates exactly one version   | `packages/orchestrator/src/workflow-orchestrator.test.ts` — hook fires once for a mutating step, never for a non-mutating one                                                              |
| Compare shows a diff between two versions               | `packages/persistence/src/workspace-manager.test.ts` — `diff`; `packages/orchestrator/src/project-version-service.test.ts` — `compare`; `apps/api/src/project-versions.test.ts`            |
| Revert creates a new version, never rewrites history    | `packages/orchestrator/src/project-version-service.test.ts` — `revert` leaves the source version's stored record untouched                                                                 |
| Branch from a version creates an independent baseline   | `packages/persistence/src/workspace-manager.test.ts` — `createBranch` doesn't move the current branch; `project-version-service.test.ts` — `branchFrom` never calls `commit`/`restoreTree` |
| Protected version survives a concurrent-update conflict | `packages/persistence/src/project-version-repository.test.ts` — stale `expectedVersion` rejection and immutable-field-on-update rejection                                                  |

### Boundaries of this coverage

`protected` is stored but nothing enforces it yet — no cleanup/retention job exists anywhere in this
codebase (see ADR 0021); a future GC job must check the flag. Version recording is hooked at the
mutating-step level, not per-Operation — the Conversation domain (issue #36) that introduces `Operation`
was developed in parallel and had not landed on this branch. `compare` returns a raw unified diff; there
is no semantic schema/config diff parser, consistent with the ADR's stated scope cut. Web panel coverage
is limited to the routes and client functions (`apps/web/lib/api.test.ts`); the panel component itself
has no automated test, matching this app's existing UI-coverage level (manual/Playwright evidence only
where it already exists, e.g. issues #14 and #16).

## Versioned task taxonomy — 2026-07-18

Issue #61 keeps `TaskKind` and the execution request compatible while adding taxonomy v2 category paths,
deterministic feature extraction, exact-category metrics with v1 fallback, and hierarchy on the existing
route dashboard.

Focused evidence commands:

```bash
npx vitest run packages/contracts/src/task-taxonomy.test.ts packages/contracts/src/run.test.ts packages/persistence/src/workflow-repository.test.ts --pool=threads --maxWorkers=1
npx vitest run packages/orchestrator/src/task-profiler.test.ts packages/orchestrator/src/prompt-compiler.test.ts --pool=threads --maxWorkers=1
npx vitest run packages/persistence/src/metrics-repository.test.ts packages/model-router/src/score-router.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts packages/orchestrator/src/failure-injection.test.ts packages/composition/src/runtime.integration.test.ts --pool=threads --maxWorkers=1
npm run e2e --workspace @agent-foundry/api
```

The first command covers the taxonomy contract and legacy workflow/profile parsing. The second covers
declared and classified profiles. The third covers metric migration and fallback, router category
queries, workflow metric writes, failure paths, and composed runtime attribution. The real golden-flow
E2E seeds a v2 frontend route, verifies the root group plus full category/version/features, reruns the
existing preview and approval journey, and retains its Axe scan.

Full gates:

```bash
npm run check
npm run e2e --workspace @agent-foundry/api
npm run doctor
git diff --check
```
