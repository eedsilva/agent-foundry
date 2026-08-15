# ADR 0065: Reclaim idle generated environments with project-scoped coordination

- Status: Accepted
- Date: 2026-08-15
- Owners: Core
- Tracked by issue #292

## Context

Generated Supabase environments are durable local resources. Leaving an idle
environment running consumes containers and ports, while stopping one that has
an active preview or workflow run breaks user work. Environment metadata already
records `updatedAt`, but a reaper needs a complete view of active runs and must
coordinate with preview startup.

## Decision

- The API periodically enumerates environment metadata and stops only healthy
  environments older than the configured idle threshold.
- The reaper queries the repository's non-terminal workflow runs directly; it
  does not use a bounded recent-run window.
- Preview startup, file-backed workflow-run creation, and the reaper share a
  project-scoped filesystem lifecycle lock. The reaper repeats the
  active-preview check while holding that lock.
- Reusing a healthy environment through `initialize()` refreshes `updatedAt`.
- Reclamation stops the environment only. It does not delete project metadata,
  workspaces, databases, volumes, or preview-session records. A later
  `initialize()` starts a stopped environment again.

## Consequences

Idle environments are reclaimed without losing durable project state, and a
preview cannot become active between the reaper's final preview check and its
stop operation, and file-backed run creation cannot race that stop. The run
query is storage-level and therefore sees old paused or approval-waiting runs.
Postgres deployments still require their database-backed run creation path to
adopt the same project lock before claiming this guarantee across processes.

## Validation and rollback

Unit tests cover idle and boundary decisions, malformed metadata, active
previews, non-terminal runs, project-lock serialization, stop failures, and
healthy-environment timestamp refresh. The focused platform, persistence,
preview-service, and API tests plus the repository check are the release gate.

To roll back, disable the environment reaper schedule and revert the
`listNonTerminal` and project-lock changes; no data migration is required.
