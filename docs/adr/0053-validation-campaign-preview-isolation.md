# ADR 0053: Keep validation campaign previews off the product router

- Status: Accepted
- Date: 2026-08-03
- Owners: Core, Model Router
- Amends issue #391 and PR #403

Issue #394 later adds the explicit run-scoped execution boundary described in
[`0054-validation-campaign-run-budget.md`](0054-validation-campaign-run-budget.md); this ADR
records the preview-only decision at the #391 boundary.

## Context

PR #403 added the opt-in `real-todo-v1` campaign preview and constructed its restricted
catalog and task-kind route table in the composition runtime. The selected campaign was then
applied to the one `TableModelRouter` shared by the workflow orchestrator and conversation
operation runner. That made an operator's preview setting change normal project execution in the
same process: deep models disappeared from the normal catalog and campaign routes replaced the
workflow's table.

Issue #391 is a pre-execution inspection slice. It has no campaign-specific project, run, or
worker execution seam yet. The parent specification requires the normal web workflow to remain
unchanged while the operator inspects the campaign.

## Decision

When `VALIDATION_CAMPAIGN=real-todo-v1` is selected:

- the runtime validates the expected identities and builds the source, catalog, route, and limit
  preview exposed by `GET /validation/campaign`;
- the shared `runtime.router` is always built from the complete enabled model catalog without a
  campaign routing override; and
- the normal workflow and conversation paths continue to receive their configured workflow table.

The current campaign selection does not start an execution. A later campaign runner must receive
an explicitly campaign-scoped router or equivalent run-scoped routing context. It may not reuse a
process-wide override on the product router.

## Alternatives considered

- **Keep the process-wide campaign override.** Rejected because selecting a diagnostic preview
  changes unrelated projects and conversation operations in the same API/worker process.
- **Add a project or run campaign field now.** Rejected for this slice because #391 does not have
  a campaign execution seam or campaign workflow; adding persistence and propagation without a
  consumer would expand the public contract before the next campaign issue owns it.
- **Construct a second campaign router now.** Rejected because no current worker path consumes it;
  the preview contract already contains the complete restricted route data needed by that future
  seam.

## Consequences

The selected preview remains fail-closed and inspectable, while normal projects retain the full
catalog and workflow routing. There is no persistence or migration change. Campaign execution is
not provided by this decision; the next campaign implementation must make its routing boundary
explicit and test it through the public runtime/run seam.

The preview describes intended campaign routes, not routes applied to current product runs. The
operator documentation and UI must keep that distinction visible.

## Validation and rollback

The API/runtime regression test selects the campaign, asserts the preview remains available, and
routes a normal planning profile through the `web-app-v1` table, proving the full catalog and
normal route source remain active. Existing validation-campaign contract tests continue to cover
identity drift and the restricted preview itself. UI tests cover the operator preview and its
navigation entry.

Rollback is a code revert of this ADR's runtime, test, documentation, and UI wording changes. It
would restore the process-wide override and therefore must not be performed without also restoring
an explicit campaign-scoped execution boundary.
