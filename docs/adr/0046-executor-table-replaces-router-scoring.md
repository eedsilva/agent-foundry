# ADR 0046: A readable executor table replaces router scoring

- Status: Accepted
- Date: 2026-07-29
- Owners: Core
- Builds on ADR 0043 (`for-each-task`) and ADR 0045 (per-task deterministic verification)

## Context

`ScoreBasedModelRouter` scored every catalog model across capability, context, speed, cost,
reliability and tag affinity, weighted them by the step's priorities, and picked the winner. Two
things were wrong with it.

**It optimised on a prior that could not see the run.** On run `01KYCH4FJFZ5HDJTNX986B6P9Q` it sent
both review steps to Haiku on a cost score of 0.950 and a speed score of 0.962, against a reliability
of 0.545. The Haiku step then cost *more* than the Sonnet step before it, because its context was
2.4× larger. The cost dimension came from a static per-model prior; context size is a property of the
step.

**It had nothing to fit against.** Six weighted dimensions imply a model fitted to outcomes. No task
had ever succeeded, so there was no per-task, per-executor record to fit to. The weights were
hand-tuned numbers presented as measurement.

## Decision

- Task kind maps to an **ordered list of executors** in workflow configuration. Attempt one takes the
  head. `claude`, `codex` and `agy` are the three `BaseCliExecutor` subclasses that already exist;
  all three appear in every list for two plain reasons — three subscriptions are three quota pools,
  and a different vendor is a genuinely different attempt. `mock` is excluded: it is a test double.
- **The table picks the executor; the catalog's order picks that executor's model.** Both are files
  the operator edits, so the decision is predictable before the run starts. This is a deliberate
  consequence: `models/catalog.yaml` lists `claude-opus` before `claude-sonnet`, so a claude-headed
  entry runs opus until the operator reorders the catalog. Reordering a file beats predicting a
  weighted sum.
- A workflow that declares no `routing` falls through to `DEFAULT_ROUTING_TABLE` in
  `packages/contracts`, and anything a workflow's table leaves out falls through per task kind. The
  route audit records **which table answered** (`source`: the workflow id, or `default`), the entry's
  ordered executors, and the index selection landed on.
- `web-app-v1` leads `repair` and `verification` with a different vendor from `implementation`:
  re-reading your own work is the weakest check there is.
- Selection computes no scores at all, so `RankedModel.score` becomes optional and the Router tab
  shows the table, its ordered executors and which one ran, instead of a grid of dimensions.
- Eligibility is unchanged and still hard-gates ahead of the table: policy and profile provider
  allowlists, workspace-write capability, context size, and the circuit breaker. An open breaker
  bounces an executor however high the table ranks it.
- Per-task, per-executor outcome is recorded on the timeline: `task.completed` carries the executor
  and model that produced it, and `task.failed` carries the executors the attempt walked, in order,
  plus the one it gave up on. That is the record a scored router could later be fitted to.

## Consequences

- `score-router.ts`, `exploration.ts`, `confidence.ts`, `quality-signals.ts` and `clamp.ts` are
  deleted with their tests. `circuit-breaker.ts` and `calibration.ts` stay: the breaker is still a
  gate, and the calibration report reads metrics directly rather than through the router.
- Epsilon-greedy exploration goes with them. It existed to gather data for a scored router; the table
  gathers the same data by recording per-task outcomes, without steering live runs off the head of
  the list.
- `RouteScoreBreakdown` survives in `packages/contracts` because route decisions persisted under the
  scored router still carry one. The Router tab renders those as "rota sem tabela" rather than
  reviving the dimension grid.
- Pinned models and the emergency ceiling are untouched. A pin overrules the table, and no table
  entry is claimed for a decision the operator made.
- Escalating to the next entry after a real failure is **#327**, not this change. The orchestrator
  already walks `fallbacks` when a candidate fails, and those fallbacks are now in table order, but
  nothing here ties escalation to a verification failure.
