# ADR 0050: Structured and redacted provisioning failure diagnostics

- Status: Accepted
- Date: 2026-07-30
- Owners: Platform, Core
- Builds on ADR 0049 (bounded Supabase provisioning and preserved timed-out workdirs)

## Context

Issue #367 found that the asynchronous `project.provisioning_failed` timeline
event exposed a duplicated Supabase CLI transcript, the local provisioning
workdir, and no structured indication of the failing phase or exit code. The
top-level project error was already concise, but the expanded diagnostic was
not safe or useful for an operator.

## Decision

- The asynchronous diagnostic path redacts provisioning workdir arguments and
  credentials, and deduplicates overlapping CLI output before persistence. The
  existing runtime byte cap remains the bound for runtime diagnostics.
- The orchestrator persists a versioned diagnostic with `phase`, optional
  `exitCode`, concise `summary`, actionable `context`, and bounded `logs`.
- The web timeline renders the summary and context first, with logs behind the
  existing expandable detail. Legacy unstructured provisioning diagnostics are
  not rendered because their redaction cannot be verified.
- The backend remains authoritative for the persisted event; the UI only
  chooses a safe presentation of the validated contract.
- File and Postgres event stores validate the event again after redaction, so
  redaction cannot expand a bounded diagnostic beyond its contract.

## Alternatives considered

- **Only hide the transcript in the web UI.** Rejected because unsafe and
  duplicated data would remain in the persisted event and other consumers.
- **Persist the raw CLI error and parse it in the UI.** Rejected because the
  provider output is not a stable public contract and can contain host paths or
  credentials.
- **Migrate all historical events.** Rejected because the event store is
  append-only; legacy diagnostics are safely suppressed at render time.

## Consequences

Operators get a compact failure summary without losing bounded logs for
inspection. New consumers can rely on the versioned diagnostic shape. Existing
legacy events remain readable as events, but their raw diagnostic is intentionally
not exposed by the web timeline.

## Validation and rollback

Contract, domain redaction, orchestrator, and web tests cover structured
persistence, deduplication, workdir redaction, legacy suppression, and
expandable logs.
Rollback is a revert of this ADR's implementation commit; it does not rewrite
existing events.
