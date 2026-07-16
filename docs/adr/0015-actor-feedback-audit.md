# ADR 0015: Actor-aware feedback artifacts and run audit export

## Status

Accepted — 2026-07-16.

## Decision

Human approval feedback reuses the existing immutable approval decision repository and artifact
store. New decisions retain the legacy `decidedBy` string and also store an `ActorRef` (`user`,
`system`, `worker`, or `provider`). Legacy decisions need no backfill: they remain valid on read,
and a legacy approval API input is normalized to a `user` actor on its next write.

`request-changes` redacts the note before either decision or artifact persistence, writes the
configured repair artifact as a typed `FeedbackArtifact`, and records its exact name, revision,
and SHA-256 on the retry directive. The retried attempt includes that exact revision in its inputs
and request markdown. No feedback repository or dependency is added.

`GET /runs/:runId/audit` reads the existing approval and artifact stores and returns request,
decision, and feedback entries ordered by timestamp and then stable identifier.

## Security

Redaction handles nested sensitive keys and token, authorization, and cookie strings before they
reach durable approval or artifact files. `DATA_DIR` still contains project and provider output
and must remain access-controlled; redaction reduces accidental credential retention but is not a
substitute for filesystem protection.

## Migration and rollback

Existing data needs no migration: the new reader accepts old decisions without `actor` and runs
without `feedbackArtifact`. That compatibility is one-way. Pre-upgrade strict schemas cannot read
records written with the new `actor` or `feedbackArtifact` fields, so a code-only downgrade is not
safe. Before upgrading, snapshot `DATA_DIR`. To downgrade, stop every worker first, restore that
pre-upgrade `DATA_DIR` snapshot, and only then start the older application. Do not run old and new
workers against the same data directory.

## Consequences

The audit export is reconstructed rather than separately persisted, avoiding a second source of
truth. Export cost is a linear scan of one run's approvals plus project artifact metadata; add an
indexed audit store only if measured project history makes that endpoint too slow.
