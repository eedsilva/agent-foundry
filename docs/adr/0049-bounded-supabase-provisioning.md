# ADR 0049: Bound Supabase provisioning and preserve timed-out workdirs

- Status: Accepted
- Date: 2026-07-30
- Owners: Platform, Core
- Builds on ADR 0030 (isolated generated-project runtime)

## Context

Issue #365 exposed a retry path where `supabase start` could remain alive while a
local Supabase container stayed in health-check startup. Project provisioning had
no deadline, so the project and run remained `running` without a step boundary or
actionable diagnostic. Pausing the run could not resolve work that had not reached
a step.

## Decision

- Real generated-project initialization has a configurable
  `SUPABASE_PROVISIONING_TIMEOUT_MS`, defaulting to ten minutes.
- The default Supabase CLI subprocess receives the deadline through execa's
  `cancelSignal`. Injected commands use the same deadline race so deterministic
  tests and alternate adapters cannot leave the initialization promise pending.
- When initialization times out, the runtime attempts a bounded
  `supabase stop --no-backup --yes` after a stack has been started, reports a
  redacted bounded diagnostic, and preserves the partial workdir for inspection
  and backup. A later retry reclaims that workdir before reinitializing it.
- Existing project-service failure handling remains the backend authority for
  persisting the terminal project/run state and provisioning event. The web
  timeline renders that event's diagnostic alongside existing preview failures.

## Alternatives considered

- **Leave the CLI unbounded.** Rejected because a provider readiness stall keeps
  the project and run non-terminal indefinitely.
- **Race the promise without cancelling the CLI.** Rejected because the UI could
  become terminal while the Supabase child process and containers continued to
  consume resources.
- **Delete the partial workdir immediately.** Rejected because the timeout needs
  an actionable inspection/backup path; retry already provides the cleanup point.

## Consequences

Provisioning now converges to the existing terminal failure path within a bounded
window, with cleanup and retry guidance visible in the event timeline. A timed-out
workdir can consume disk until retry or explicit operational cleanup, so the
diagnostic and operations runbook must remain clear that it is retained on purpose.
The timeout is configurable for hosts whose Docker/Supabase readiness time differs
from the default.

## Validation and rollback

The runtime test covers a stuck `start`, bounded stop, preserved workdir, redacted
diagnostic, and retry-safe state. Configuration, project-service, worker, and UI
tests cover propagation and terminal-event visibility. Rollback is a revert of
this ADR's implementation commits; it does not change persisted project records.
