# ADR 0016: Audited model overrides and emergency execution ceiling

## Status

Accepted — 2026-07-16.

## Decision

Model pins are immutable records attached to a run. Each record stores the resolved catalog tuple
(`modelId`, provider, and model), run or step scope, `ActorRef`, reason, estimated impact, creation
time, and a monotonic per-run sequence. Routing resolves one explicit pin at an agent-step boundary
with this precedence:

1. the retry directive for that step;
2. the newest matching step override;
3. the newest run override.

An explicit pin produces one routing candidate and no fallback. It still passes through the
router's existing hard constraints: the resolved catalog tuple must be unchanged, the model must
remain enabled, ProjectPolicy and step provider allowlists apply, context capacity must be
sufficient, and a workspace-mutating step requires workspace-write capability. The resulting
`RouteDecision.override` retains the actor and reason for audit.

Legacy `maxAttempts` and `maxIterations` remain parse-compatible but no longer terminate ordinary
execution. Automatic routing tries its finite selected/fallback list once. A quality loop ends on
approval, cancellation, an unrecoverable error, or the emergency ceiling.

The run persists active execution time and consecutive completed repairs. The ceiling is reached
at `14_400_000ms` of active time or on the tenth consecutive completed repair. Persisted `paused`
and `awaiting_approval` waits do not count. A run that remains `running` across process restart
continues counting wall time from its persisted `activeSince`; this fail-safe bias prevents a crash
loop from extending the ceiling. A successful quality approval resets the repair count.

The orchestrator records the initial Git HEAD and advances `lastVerifiedCheckpoint` only after an
approved verification result. At the ceiling it commits the current tree when dirty, owns the
result through `draft/<runId>`, resets and cleans the active workspace to the verified checkpoint,
fails the run with `EMERGENCY_CEILING`, persists the draft branch, and emits one deduplicated
`run.emergency_ceiling_reached` event. Replays reuse only a safely recognized draft. A conflicting
draft ref or dirty replay fails closed instead of discarding work.

Cancellation retains precedence during execution and every ceiling-finalization race. A newly
created ceiling draft is removed only with an expected-commit compare-and-delete if cancellation
wins; an independently moved draft is never deleted.

## Security

New API writes require the exact catalog `modelId` tuple, actor, reason, and estimated impact.
These audit strings are redacted before persistence. Pins cannot grant provider, context, or
workspace-write capability and cannot bypass ProjectPolicy. `DATA_DIR` and generated Git
workspaces still contain operational metadata and provider output and require filesystem access
controls. Do not publish raw run files or draft contents as evidence.

## Migration and rollback

There is no destructive migration or backfill. New readers accept runs without `execution`, old
retry directives without audit fields or `modelId`, and legacy workflow budgets. A legacy retry
tuple resolves only when it names one enabled catalog entry; zero or multiple matches fail closed.
New model-override records and execution state are written only as the feature is used.

Before upgrade, stop workers and snapshot `DATA_DIR`, including generated workspaces and their Git
refs. Do not mix old and new workers. For downgrade, stop workers, preserve any required
`draft/<runId>` branch outside the data directory, restore the pre-upgrade snapshot, then start the
old version. A code-only rollback is not the supported recovery path because older strict run
schemas do not accept the new execution state.

## Consequences

Operator intent is durable and visible without weakening routing policy. The ceiling bounds
pathological loops while preserving failed work for inspection. The active clock is deliberately
boundary-driven and restart-safe rather than a separate scheduler; an outage recorded as
`running` consumes budget, favoring containment over extra execution time.
