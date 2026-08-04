# ADR 0054: Enforce validation budgets at the campaign run boundary

- Status: Accepted
- Date: 2026-08-03
- Owners: Core, Orchestrator, Model Router
- Amends issue #394 and parent #390

## Context

The `real-todo-v1` preview described the route and limits but did not attach them to a run. A
worker could therefore use the normal catalog, walk an automatic fallback, or lose provider usage
when a process restarted after the provider responded.

## Decision

An explicitly selected campaign snapshots its complete preview into
`WorkflowRun.execution.campaign`. The snapshot is independent of the platform emergency ceiling.
The orchestrator enforces the snapshot immediately before each model dispatch:

- automatic routing accepts only the snapshot model identities and route order;
- the first attempt per logical agent step and one targeted repair are the defaults;
- known active time and known metered spend are checked before dispatch;
- provider-reported cost, catalog-estimated cost, unknown cost, and subscription quota remain
  separate; persisted attempts are the source for restart/resume accounting; and
- a model outside the snapshot requires an audited override bound to the exact failed step and
  containing a minimal reproducer, reason, actor, and expected impact.

Cancellation is checked before campaign limits. Normal runs have no campaign state and retain the
existing router and platform emergency ceiling.

## Alternatives considered

- Enforcing the limits only in the validation preview or worker configuration was rejected
  because a restarted worker could lose the selected route and accumulated usage.
- Replacing the normal model router with a campaign-specific router was rejected because it would
  widen the change and could alter ordinary product runs; the existing router receives explicit
  run-scoped constraints instead.
- Treating unknown provider cost as zero or as a guessed estimate was rejected because it would
  turn missing evidence into false budget compliance.

## Consequences

The campaign is explicit and run-scoped rather than a process-wide router mutation. A provider
fallback cannot bypass a campaign budget because every candidate is checked at the dispatch seam.
Unknown provider pricing is recorded as unknown; it is never converted to zero or an estimate that
was not supplied by the provider or catalog. A future evidence-classification issue owns whether
unknown accounting prevents acceptance.

## Validation and rollback

Contract, router, accounting, and public orchestrator tests cover exact attempt boundaries,
unknown/estimated/reported usage, subscription quota, active-time stop, cancellation precedence,
premium override audit, fallback exclusion, and persisted attempt accounting. Removing
`VALIDATION_CAMPAIGN` affects only new runs; existing snapshots remain readable and enforceable.
