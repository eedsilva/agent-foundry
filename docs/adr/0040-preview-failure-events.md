# ADR 0040: preview failures are diagnostic events

- Status: Accepted
- Date: 2026-07-27
- Owners: Core
- Amends: ADR 0018's terminal-diagnostic persistence clause; the rest of ADR 0018 stands

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
- Runtime evidence is preserved not only when a server fails to start but also when a
  healthy server exits after startup: `stop()` returns the last tracked exit code and
  captured output when the process had already exited, and the service attaches it to
  the failure only when the session carries none of its own — not when stop terminates
  a still-running healthy session.
- Captured and emitted stdout/stderr are bounded by UTF-8 bytes, not string length;
  truncation trims forward to the next code-point boundary so it never emits invalid
  UTF-8.
- The repair lookup scans the whole project event history for the latest
  `preview.failed` event, widening past the event store's default page instead of
  only ever seeing the newest events.
- A `preview.failed` event with no embedded diagnostic falls back, on read only, to
  the legacy `preview-failure-<sessionId>` artifact; the fallback never writes,
  mutates, or deletes an artifact.

## Consequences

Operators can diagnose boot failures from the project event timeline, and repair
agents receive the same evidence without artifact-name discovery. Legacy data is
preserved, and old sessions whose event has no embedded diagnostic resolve it from
their artifact on read via the repair lookup, without reviving artifact writes.
