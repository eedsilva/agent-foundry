# ADR 0010: Persist workflow runs as independently versioned entities

- Status: Accepted
- Date: 2026-07-14
- Owners: Core and Persistence

## Context

The v0.1 project record stored aggregate execution status while individual provider attempts existed only as events and `run-*` audit artifacts. That shape could display progress, but it could not safely resume, retry, audit, or update one step without treating `Project` as the execution source of truth. File persistence also had atomic replacement but no protection against two writers updating the same entity from the same snapshot.

## Decision

Persist `WorkflowRun`, `StepRun`, and `StepAttempt` separately beneath `DATA_DIR/runs/<runId>/`. Every entity starts at version 1 and updates with compare-and-swap under a per-entity directory lock. Invalid state transitions and stale versions fail explicitly. `Project` keeps `currentRunId` plus the existing status, current-node, and error fields only as a derived compatibility summary.

Every executable occurrence gets a `StepRun`, including repeated quality-loop checks and repairs. Every provider candidate and deterministic verifier invocation gets a `StepAttempt`. Attempts record provider, requested and reported model, checkpoint, usage, sanitized error, routing/harness context, and input/output artifact references. Executor request files are namespaced by run, step, and attempt. Immutable audit artifacts remain the detailed evidence record and carry the same three identifiers.

New queue jobs carry `runId`. A v0.1 job without it creates a run lazily. Legacy projects default to version 1 when read, and existing events/artifacts remain untouched; no attempt hierarchy is fabricated from incomplete historical evidence.

New executor requests require run, step-run, and attempt identity. Execution results persist all three for native runs while keeping the two new child identifiers optional on read so older result payloads remain valid.

## Alternatives considered

Embedding every step and attempt in one run document was rejected because unrelated updates would contend on the aggregate and rewrite a growing file. Event sourcing was rejected because projections, replay, and event-version migration are disproportionate for the single-filesystem v0.2 runtime. Reconstructing old attempts was rejected because historical artifacts do not reliably encode the complete run/step/attempt relationship.

## Consequences

Run state is directly queryable and forms a stable base for cancellation, pause/resume, leases, and step retry. Optimistic concurrency detects stale writers, but this is still single-filesystem coordination rather than distributed consensus. Cross-file creation is not transactional, and idempotency after a crash between artifact and state writes remains a separate roadmap item.

Attempt errors exclude raw stdout/stderr. Existing bounded audit artifacts still contain provider diagnostics and must remain local and access-controlled. Backups must include the new `runs/` tree.

## Validation and rollback

Contract tests cover timestamps and illegal transitions. Repository tests cover create/get/list/update, malformed data, duplicate IDs, and concurrent stale updates. Runtime tests cover success, fallback, coordinated failure, retry, verifier attempts, and a legacy queue job.

Rollback stops all workers first and restores the pre-upgrade `DATA_DIR` snapshot when execution continuity matters. Older code ignores `DATA_DIR/runs/`, but it may remove `version` and `currentRunId` when rewriting a project; do not run mixed versions against the same data directory.
