# ADR 0056: Dismantle the validation campaign bureaucracy

- Status: Accepted
- Date: 2026-08-07
- Owners: Core, Orchestrator, Model Router
- Amends ADR 0054 and ADR 0046; resolves issues #439 and #358

## Context

The `real-todo-v1` campaign finished its job: #398 closed with an accepted evidence bundle after
11+ real defects were fixed. Much of the machinery built for it (ADR 0054) existed to bound an
investigation that is now over, and #358 had already flagged routing contract fields that nothing
writes since the executor table (#326). Every catalog model is subscription-billed; the
metered/unknown cost classes never occurred in practice.

## Decision

Delete the campaign bureaucracy, keep the useful residue:

- **Premium promotion audit** — removed. An operator pin outside the campaign snapshot uses the
  normal override contract (`actor`, `reason`, `estimatedImpact`); `failedStep` and
  `minimalReproducer` are no longer accepted on new override/retry requests and promotions no
  longer consume the targeted-repair budget. Persisted records that carry the audit fields still
  parse (optional legacy).
- **Cost classes** — `ModelDefinition.billingMode` is gone; everything is subscription. The
  campaign metered ceiling (`limits.meteredCostUsd`), the `metered-cost`/`unknown-cost` limit
  reasons, and the aggregate cost cross-checks in the evidence usage block
  (`providerReportedCostUsd`, `catalogEstimatedCostUsd`, `meteredCostUsd`,
  `unknownMeteredAttempts`) are removed from writers and kept optional in parsers so old
  snapshots and published bundles still load. Per-attempt usage remains the cost evidence.
- **Routing fields nothing reads (#358)** — `TaskProfile.priorities` (and the workflow-declarable
  `profile.priorities`), `RankedModel.quality`/`confidence`, and `RouteDecision.exploration` are
  removed. These schemas are non-strict, so persisted route decisions written before #326 parse
  with the legacy keys stripped. `RankedModel.score`/`RouteScoreBreakdown` stay because old
  decisions carry them and the Router tab renders them.
- **Kept** — the campaign preview/selection flow, preflight (environment doctor), attempt and
  targeted-repair bounds, active-time ceiling, passive subscription-quota signals from executor
  health, and the redacted evidence bundle. Converting the campaign flow into a CI pipeline
  regression test is #416.

## Consequences

Operator overrides behave the same with or without a campaign selected. Budget enforcement is
attempts, targeted repairs, active time, and observed subscription quota — no dollar accounting.
Old runs, overrides, and evidence bundles parse unchanged; new writers simply stop emitting the
retired fields.
