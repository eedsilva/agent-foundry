# ADR 0018: Durable preview lifecycle with API-owned reaping

- Status: Accepted
- Date: 2026-07-16
- Owners: API, Orchestrator, Executors, and Persistence

## Context

ADR 0017 introduced the loopback preview proxy, but preview sessions existed only in process memory. An API restart lost lifecycle state, logs were not durably queryable, and crashed or expired dev servers could remain orphaned. Issue #31 requires bounded restart, deterministic recovery, redacted cursor logs, and diagnostics without weakening the proxy security boundary or automatically spending more agent capacity on repair.

## Decision

Preview state is stored under `DATA_DIR/previews/<sessionId>/`: `session.json` contains a versioned session and SHA-256 token digest, while `logs.json` contains byte-bounded structured stdout/stderr with monotonic cursors. Raw access tokens remain transient response/cookie material and are never written to session, log, event, or diagnostic files. Redaction occurs before log persistence; terminal diagnostics are redacted again before the existing artifact store writes `preview-failure-<sessionId>`.

`FilePreviewSessionRepository` provides optimistic version updates and redacts all session free text before writing, `FilePreviewLogRepository` provides cursor pages and bounded retention, and owner-aware directory locks serialize repository and lifecycle operations across processes. Locks persist a PID and unique ownership token, reclaim dead or malformed stale owners, never steal a lock solely because a live owner is old, and release only when the token still matches. `NodePreviewRunner` owns HTTP probing, log capture, process detection, and process-tree termination. `PreviewService` owns state transitions, TTL, consecutive-failure policy, at most two restarts by default, deduplicated lifecycle events, and one deterministic `reap()` sweep. It never enqueues repair.

The singleton API entrypoint is the sole scheduler owner; generic `buildApp()` construction never registers it. The entrypoint starts one caught and tracked `PreviewService.reap()` immediately, then repeats per `PREVIEW_REAP_INTERVAL_MS`, skips a tick while the prior sweep is running, logs aggregate failures, and unreferences the timer. Its idempotent stop operation is bound to Fastify `onClose`, so direct or signal-driven close clears future ticks and awaits the caught active sweep before Fastify finishes closing. The standalone and inline workers have no preview scheduler.

The public logs endpoint is `GET /projects/:projectId/preview/:sessionId/logs`. It accepts optional canonical decimal text for a nonnegative `cursor` and `limit` from 1 through 200 (repository default 200); coercible noncanonical forms are rejected. Logs and stop both load the durable session first and return `404` when its project does not match the route, so knowing a session ID does not grant cross-project access. Existing start and stop response bodies remain unchanged. Start associates `project.currentRunId` when present.

Defaults are `PREVIEW_STARTUP_TIMEOUT_MS=10000`, `PREVIEW_HEALTH_PATH=/`, `PREVIEW_HEALTH_INTERVAL_MS=1000`, `PREVIEW_HEALTH_FAILURE_THRESHOLD=3`, `PREVIEW_MAX_RESTARTS=2`, `PREVIEW_REAP_INTERVAL_MS=5000`, and `PREVIEW_LOG_MAX_BYTES=1000000`; `PREVIEW_TTL_SECONDS=1800` remains unchanged.

Startup has two sequential windows using `PREVIEW_STARTUP_TIMEOUT_MS`: the runner's spawn/port-confirmation window followed by the service's HTTP-health window. The default worst case is therefore about 20 seconds, excluding dependency installation.

Lifecycle lock recovery assumes all processes sharing `DATA_DIR` share the host PID namespace. Liveness uses the persisted PID and the operating system's process check. Sharing one data directory across hosts or isolated PID namespaces is unsupported; PID reuse can conservatively retain a stale lock until an operator verifies and removes it.

## Alternatives considered

- A worker-owned or duplicate API/worker scheduler was rejected because multiple independent schedules add overlap and ownership ambiguity. The service remains deterministic and scheduling stays at the API lifecycle edge.
- A database, broker, or new locking dependency was rejected for the local filesystem MVP. Existing atomic file and directory-lock primitives cover the required boundary.
- Migrating legacy sessions was rejected because the prior implementation had no durable session records. Inventing tokens, PIDs, or health state would be unsafe.
- Automatic repair enqueue was rejected because preview failure diagnostics are evidence, not authorization to incur provider work.

## Consequences

API restart now begins converging active sessions in an immediate reap sweep. Logs can lose old entries when their configured byte ceiling is reached; `truncatedBeforeCursor` makes that loss explicit. Failure diagnostics retain the newest 200 available entries and use the same field to identify the first included cursor when older retained entries are omitted. A sweep continues across session failures and raises one `AggregateError`, which the API logs without overlapping the next in-flight sweep. Disk usage remains bounded per log file but session metadata, events, and diagnostic artifacts still require normal `DATA_DIR` backup/retention.

Security remains local/trusted-operator only: loopback proxy controls from ADR 0017 still apply, access tokens are digest-only at rest, and a centralized request serializer redacts case-insensitive/encoded `token` query keys before access logging while retaining other URL data. Project ownership is checked at logs/stop boundaries, and persisted diagnostic material must be protected as sensitive even after redaction.

## Migration, rollback, and recovery

Upgrade requires stopping the old API and preview processes; there is no backfill. New sessions create the durable format. Before rollback, stop the API and persisted preview PIDs, snapshot `DATA_DIR/previews`, and restore a pre-upgrade snapshot if necessary. An older binary ignores the new files but cannot reap their processes, so code-only rollback is insufficient.

Recovery starts with the log endpoint, session file, project events, and failure artifact. Operators must verify command/workspace ownership before killing a persisted PID and must confirm the lock owner is dead in the same PID namespace before removing `.lifecycle.lock`. Restarting the API resumes deterministic reaping. Corrupt state is preserved for investigation and restored from snapshot rather than deleted opportunistically.

## Validation

Contract, persistence, runner, service, composition, and API suites listed in `docs/VALIDATION.md` cover the storage and lifecycle boundaries. Release evidence requires root typecheck, targeted and relevant full tests, `npm run doctor`, and `git diff --check`.
