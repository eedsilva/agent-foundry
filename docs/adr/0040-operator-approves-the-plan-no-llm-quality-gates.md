# ADR 0040: the operator approves the plan; no model grades another model's prose

- Status: Accepted
- Date: 2026-07-27
- Owners: Core
- Supersedes the plan and architecture portions of the `web-app-v1` gate design

## Context

`web-app-v1` reached its first line of code through three `quality-loop` gates. Each gate is an LLM
producer, an LLM reviewer, and an LLM repairer at `maxIterations: 3`. Reaching the plan gate alone
could cost seven model calls; reaching implementation, roughly fourteen — all of it prose, to compute
an `approved: true` bit the operator was going to set anyway from Approve/Reject buttons that already
exist on the project page.

Two observed runs make the cost concrete. `01KYCH4FJFZ5HDJTNX986B6P9Q` spent 13m21s and $2.91 across
`plan`, `review-plan` and `repair-plan` and produced zero lines of application code. #297 is worse and
structural: a "Status App" PRD whose non-goals say *no auth* was rejected four times in 23 minutes by a
reviewer that invented an access-control requirement (NFR-09) and a no-mutable-images requirement
(NFR-10) the PRD never asked for — and kept looping past `maxIterations: 3`, which #211 confirms the
engine ignores. No amount of re-planning can satisfy a requirement the PRD excludes, so the loop could
not converge.

`docs/evidence/ai-app-builder-loop-architecture.md` researched whether the incumbents work this way.
A distinct planning step with a **human** approval gate is near-universal (Lovable's `.lovable/plan.md`,
Replit's task board, v0's `exit_plan_mode`, bolt's Plan/Discuss mode). An LLM reviewer grading another
agent's prose as a blocking gate appears in no primary source. Where a second model exists it is a
post-processor (v0's `vercel-autofixer-01`), a context-isolated tester (Replit), or an explicitly
read-only advisor (Lovable subagents). Repair is always triggered by a real execution failure.

The architecture gate has a second, independent problem: it re-derives written decisions. Stack,
tiering, auth model, and deployment shape are fixed by the scaffold and by ADRs 0038 and 0008. The
only genuinely per-project design work is the data model, which belongs in tasks as migrations
(ADR 0039's task graph).

## Decision

- `web-app-v1`'s `plan-gate` quality loop collapses to a plain `plan` agent node followed by a
  `plan-approval` `approval-gate` on `plan.current`. `review-plan` and `repair-plan` are deleted.
  Reaching the plan gate costs exactly one model call.
- `architecture-gate` is deleted outright, along with `architecture.current` and `architecture.review`
  and every downstream `inputArtifacts` reference to them.
- `plan-approval` declares `actions: [approve, reject]` and `onReject: end`. Reject terminates the run
  as `rejected`; the operator's note is carried on the terminal `run.rejected` event as well as on the
  immutable `ApprovalDecision`, because a rejected run has no later step to hold it.
- The `architect` and `architecture-reviewer` roles and the `architecture` and `architecture-review`
  task kinds are removed from the contracts, and their harness fragments are deleted. A workflow can no
  longer declare a role the harness has no prompt for.
- `plan-reviewer` / `plan-review` survive **only** for `dogfood-plan-v1`, which is the benchmark
  harness that scores a model's review ability and gates on it (`benchmarks/cases/review-score-router.json`).
  No product workflow runs a blocking model reviewer of another model's prose.
- The `planner` step's instructions now state that the PRD's non-goals are binding and that
  operator-only decisions are recorded as open questions in the plan rather than resolved by guessing —
  the operator reads the plan before approving it.

## Consequences

- #297 is closed. `packages/composition/src/plan-gate.integration.test.ts` drives its exact PRD shape
  through the real runtime and asserts: two step runs (`plan`, `plan-approval`), one agent attempt,
  `plan.current` at revision 1, approve advancing to `implement`, and reject ending the run with the
  reason recorded. The failure mode is now a test, not a manual check.
- `TaskCategorySchema` keeps `architecture` and `review/architecture` even though no `TaskKind` can
  reach them: persisted quality observations and router metrics from earlier runs carry those values
  and must keep parsing.
- Every mock-mode run through `web-app-v1` now passes two operator gates rather than one, so
  `approveDiffGate` generalised to `approveGate(runtime, runId, nodeId)`.
- An **advisory, non-blocking** plan review may return later, once the loop has run often enough to
  show what the operator consistently misses. It is deliberately not in this change: a smaller version
  of the deleted gate is still the deleted gate.
- The implementation gate (`implement` → `review-code` → `repair-code`) is untouched here. #323
  replaces it with per-task execution driven by deterministic signals.
