# ADR 0040: preview failures are diagnostic events

- Status: Accepted
- Date: 2026-07-27
- Owners: Core

## Context

Preview failures need to explain why the generated app did not boot. The previous
implementation wrote a new versioned `preview-failure-<sessionId>` artifact, but
the timeline and repair workflow did not consume that diagnostic consistently.

## Decision

- New terminal preview failures emit a structured `preview.failed` event carrying
  the command, exit status when known, bounded stdout/stderr, and the retained log
  tail.
- The event is the source used by the timeline and repair prompt. A repair sees
  the latest project preview failure, including failures from an earlier run.
- New preview-failure artifacts are not created. Existing
  `preview-failure-*` artifacts remain readable as a legacy fallback and are not
  deleted by this change.
- Subprocess evidence is bounded at capture time and redacted before the event is
  persisted or rendered.

## Consequences

Operators can diagnose boot failures from the project event timeline, and repair
agents receive the same evidence without artifact-name discovery. Legacy data is
preserved, but old sessions may only have the evidence available in their artifact.
