# ADR 0045: Each task is gated on deterministic checks; repair fires only on a real failure

- Status: Accepted
- Date: 2026-07-28
- Owners: Core
- Builds on ADR 0042 (operator approves the plan) and ADR 0043 (`for-each-task` executes the graph)
- Supersedes the `implementation-gate` half of the pipeline: `review-code` and `repair-code` are deleted

## Context

ADR 0043 gave every task its own implementation and its own commit, but nothing decided whether that
implementation worked. What decided it was `implementation-gate`: an LLM `review-code` step whose
`approved` boolean sent an LLM `repair-code` step back into the workspace. That gate has three
defects the research in `docs/evidence/ai-app-builder-loop-architecture.md` records across every
comparable product:

1. **It is triggered by an opinion.** #297 recorded four rejecting reviews of a plan whose PRD's
   non-goals explicitly excluded the requirement the reviewer invented. A reviewer with no ground
   truth rejects on taste, and the repairer then changes working code to satisfy it.
2. **The fixer has nothing concrete to work from.** A review write-up is prose. A compiler is not.
3. **It grades the wrong unit.** Since ADR 0043 the gate reviewed the repository plus the *latest*
   `implementation.report` revision — the last task's — which is not the same thing as reviewing
   the task that just ran.

Nothing in the pipeline ran the checks that can actually fail until every task was already built:
`deterministic-verification` sits at the tail, so a type error in task 1 surfaced after task 14.

## Decision

- `for-each-task` gains a paired `verify` (a `verify` step) and `repair` (an agent step). They are
  optional but arrive together — a gate with nothing to call is a dead end, a repairer with nothing
  to trigger it never runs — and `repair` must declare `mutatesWorkspace: true`.
- Per task, after the implementation and **before the task completes**: the checks run against the
  project workspace, and a red report — never a reviewer's verdict — invokes repair. The report is
  pinned into repair's inputs alongside the walk's own pins, so the fixer reads the exact revision
  that failed, with the command, its exit status and its captured stdout/stderr.
- `repair.maxAttempts` bounds the loop. Exhausting it fails the task with the checks still red and
  `Task <id> failed verification after N repair attempt(s): <summary>`; it does **not** re-run the
  implementation, because the bound the ticket asks for is on repair.
- A task takes a checkpoint before its first attempt and is rolled back to it when it fails, so a
  task that never goes green leaves no commit behind while every task committed before it survives.
  Control-flow errors — a pause, a cancellation — keep the work, exactly as before.
- `task.completed` is emitted only after a green report, so a task cannot be marked complete while
  any check is red. `quality.approved` / `quality.repair_requested` carry the task id, and the
  verification report itself is an artifact per task per round.
- `VerifyStep` gains two lists:
  - **`autofixScripts`** run first and never gate, recorded `advisory: true`. A formatter and
    `lint --fix` repair what a machine can, so repair is only invoked for what a machine cannot
    (carried over from #257, whose LLM-reviewer premise no longer applies).
  - **`optionalScripts`** run only when the project defines them, and are recorded `skipped` with a
    reason when it does not. `scripts` keeps its existing strict meaning — a missing required script
    is still a red report — so the tail node and the dogfood harness are unchanged.
- `web-app-v1`'s per-task gate is therefore `typecheck` (required), plus `lint`, `test`, `db:reset`
  (the migrations against the project's own local Supabase) and `smoke` (both tiers answering) as
  optional, plus the git whitespace check, with `format` and `lint:fix` as the auto-fix pre-pass.
- The deterministic verdict is what now records quality against the model that wrote the code
  (`metrics.recordQuality`, `QualityObservationService.recordDeterministic`). The blind-review
  observation source survives in the contract for `dogfood-plan-v1`, which scores review capability
  on purpose.

## Consequences

- `implementation-gate`, `review-code`, `repair-code` and the `code.review` artifact are gone from
  `web-app-v1`. `repair-verification`, `plan-browser-test` and `assess-release` no longer list
  `code.review` among their inputs. `dogfood-task-v1` keeps its own review loop: it is the benchmark
  harness that measures review capability, not the delivery pipeline.
- Zero blocking LLM gates remain in `web-app-v1`. The operator approves the plan and the diff; every
  gate between them is a command with an exit status.
- `optionalScripts` is a deliberate weakening in one direction: a generated project with no `test`
  script is not gated on tests. The scaffold ships a data plane and two tiers, not a lint config, and
  the alternative — failing every task until an agent invents one — is the failure mode #348
  recorded. The gate names all five checks and enforces each from the moment the project defines it.
- Per-task `db:reset` and `smoke` are slow, and deliberately so: they are what makes "the migrations
  apply and the preview boots" a fact rather than a claim. `MockAgentExecutor` neutralises both for
  the same reason it already neutralises `next build` — a mock run has no Docker and no install.
- The standalone `deterministic-verification` and `browser-verification` nodes still run at the tail.
  Collapsing them into one full-suite run is #329; the per-task browser assertion is #325. Neither is
  stubbed here.
- Replaying the walk after a pause re-records the deterministic quality observation for tasks whose
  steps are reused. That double-count predates this change (the quality loop did the same) and is not
  fixed here.
