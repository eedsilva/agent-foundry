# ADR 0011: Idempotent step reuse as the engine for pause, resume, and step retry

- Status: Accepted
- Date: 2026-07-14
- Owners: Core and Persistence

## Context

ADR 0010 gave runs a persisted `WorkflowRun -> StepRun -> StepAttempt` hierarchy but left three gaps: a crash between an artifact/commit write and the queue ack could repeat side effects on redelivery; there was no way to pause a run and resume it safely after a restart; and recovering from a bad step meant re-running the entire project, wasting quota and re-deciding approved steps.

## Decision

Give every step execution a deterministic idempotency key: `sha256` over run id, node id, step id, iteration, attempt policy, and the exact input artifact references. The key is stored on the `StepRun` and on the primary output artifact's metadata.

The orchestrator walks the whole workflow on every (re)delivery. Before executing a step it looks for a completed, non-invalidated `StepRun` with the same key and reuses its artifact instead of re-executing. A walk that crashed between the artifact write and the state write leaves a running `StepRun`/`StepAttempt` and an orphaned keyed artifact; the replay finalizes those records against the artifact instead of executing again. Stale running records without a matching artifact are failed and superseded. Redelivery of a terminal run is a no-op.

Pause is a run-status request (`pause_requested`) that takes effect only between steps. When the orchestrator parks the run it stores a compatibility snapshot: workflow definition hash, harness version, workspace HEAD, and the latest hash of every artifact. Resume re-validates all four and refuses with per-field diagnostics when anything drifted; restarting the project is the explicit escape hatch. A valid resume re-queues the run and the reuse rule skips completed steps.

Step retry re-opens a finished run (`completed/failed -> queued`) with a directive persisted on the run: target step, preserve-or-invalidate downstream, optional model override, and the checkpoint recorded by the original attempt. Invalidation marks old `StepRun`s (`invalidatedAt`) — history is never rewritten. The retried mutable step first rolls the workspace back to its recorded checkpoint. In preserve mode, downstream completed steps are reused even if their inputs changed, because the user explicitly chose to keep them.

Events gain an optional `dedupeKey` and the event store append becomes idempotent for keyed events, so replayed walks do not duplicate the timeline. Attempts record the workspace commit hash, making the run -> step -> attempt -> artifact -> commit trail queryable through `GET /runs/:runId`.

## Alternatives considered

Persisting an explicit resume cursor (next node index) was rejected: it duplicates state the walk can derive, and it breaks silently when the workflow shape changes. Executing retries as standalone single-step jobs was rejected because quality loops and downstream invalidation need the full walk context. Global write-ahead logging for exactly-once side effects was rejected as disproportionate for a single-filesystem runtime; keyed reuse plus git's natural no-op commit covers the realistic crash windows.

## Consequences

Replays are cheap and safe, so the queue can redeliver freely and pause/resume survives process restarts. Reuse depends on deterministic keys: any change to key composition invalidates reuse for in-flight runs (they re-execute, which is safe but costs quota). Downstream ordering uses workflow node order and assumes sequential execution; parallel nodes will need graph-based invalidation. The agent may re-execute in the narrow crash window after commit but before artifact write; the workspace commit itself is not duplicated because the tree is clean.

## Validation and rollback

`run-controls.test.ts` covers pause at a boundary, resume after a simulated restart without repeated side effects, blocked resume diagnostics, reviewer-only retry, developer retry with verifier invalidation and model override, and injected power-loss after artifact put, after commit, and before queue ack. Rollback: stop workers and revert; older code ignores the new optional fields (`idempotencyKey`, `invalidatedAt`, `pause`, `retry`, `commit`, `dedupeKey`), but runs paused or re-queued by this version should be cancelled before downgrading.
