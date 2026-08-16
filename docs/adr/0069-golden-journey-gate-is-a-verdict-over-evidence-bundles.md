# ADR 0069: The golden-journey gate is a verdict over evidence bundles, not a second source of truth

- Status: Accepted
- Date: 2026-08-16
- Owners: Core
- Tracked by issue #564
- Builds on ADR 0055 (redacted validation-evidence bundles) and ADR 0054 (validation budgets enforced at the campaign run boundary)

## Context

The v1.0 release gate is four real golden journeys — `toy`, `crud-heavy`,
`dashboard-heavy`, `auth-heavy` — each reaching a terminal pass in a real
browser against a real local Supabase, with trace, logs, executed model,
duration, cost and tested commit attached.

Everything needed to *run* one journey existed. Nothing existed to *judge* four.

`scripts/tracer.ts --all` printed one line per scenario and exited `0` whether a
run completed or crashed. The `ValidationEvidenceBundle` already carried every
field the gate needs — `sourceRevision`, per-attempt `executedModel`,
`durationMs` and `usage`, the eight mandatory gates, browser and database
references, `terminalState` — but it lived inside `DATA_DIR` as an artifact, and
every evidence document under `docs/evidence/` had been assembled out of it by
hand. A release gate cannot be four manual runs plus a human reading four
artifact trees.

The obvious shape for a gate — have the runner observe the journey itself and
record what it saw — would have produced a second, competing account of the same
run. Two accounts disagree eventually, and the one with no redaction pass is the
one that leaks a preview token into a committed file.

## Decision

**The gate derives its verdict entirely from the published evidence bundle. It
observes nothing itself.**

`evaluateGoldenJourneyGate` is pure: it takes a scenario's run status and its
`ValidationEvidenceResponse`, and returns a status plus the reasons behind it. It
reads no filesystem, starts no process, and adds no field that the bundle does
not already carry. The bundle stays the single source of truth, already redacted
by the publisher (ADR 0055), so committing it as evidence is safe by
construction.

**`passed` requires three separate claims, because they are three separate
claims.** The issue's phrase "terminal `passed`" collapses them, and
`WorkflowRunStatus` has no `passed` member at all — its terminal set is
`cancelled | completed | failed | rejected`. A scenario passes only when
`terminalState.status === 'completed'`, **and** `outcome === 'accepted'`, **and**
all eight mandatory gates report `status: 'passed'`.

Today `classifyOutcome` already refuses `accepted` to any bundle carrying a gate
that is not `passed` — `skipped` and `unavailable` included — so the third
condition cannot currently fire on its own. That redundancy is the decision, not
an oversight. `outcome` is one classifier's summary of the evidence, computed
inside a package the gate does not own and free to change; the gates are the
evidence. A release gate that reads the summary instead of the evidence is one
refactor away from signing off a run whose `database-match` was never captured —
and that gate is precisely the persistence proof the release is asking for. So
the gate asserts the gates, and the truth table pins the behaviour whether or not
the classifier keeps agreeing.

**Two outcomes are reported apart from `failed`, at the reporting layer only.**

`exhausted`, when `terminalState.error.code === 'VALIDATION_CAMPAIGN_LIMIT'`. A
run that ran out of budget is a sizing finding, not a product defect, and today
it is indistinguishable from a genuine failure in the bundle's top-level fields
(both read `product-failed`). We fix that where it is read, not where it is
stored: adding a fifth `outcome` would change a persisted contract, invalidate
every bundle already published, and encode a distinction the classifier cannot
make from evidence alone.

`no-evidence`, when no bundle exists. The evidence publisher is wired only under
a selected campaign, and a campaign is rejected outside real mode, so mock mode
can never produce one. Making that a failure would have cost the four-scenario
loop its only cheap smoke test.

**The runner does not stop at the first red scenario.** Four shapes cost hours of
wall clock and real tokens. Finding three defects in one sitting is worth more
than finding one.

## Consequences

The gate can only be as good as the bundle. A surface the bundle does not
capture is a surface the gate cannot judge — browser console errors, for one,
live inside `browser-verification.report` and reach the gate only through the
`browser-acceptance` gate's pass/fail, not as a distinct signal. Widening the
gate means widening the bundle first, which is the right order: the bundle is
redacted and versioned, and the gate is neither.

`exhausted` and `no-evidence` exist in the runner's vocabulary and not in the
schema's. Anything reading bundles directly still sees `product-failed` for an
exhausted run. That asymmetry is deliberate and is the price of not versioning
the contract; if a second consumer needs the distinction, that is the evidence
for promoting it into the schema.

The campaign's active-time ceiling becomes an explicit input
(`VALIDATION_ACTIVE_TIME_MINUTES`, fail-closed, default 60) rather than a
constant. The shipped 60 minutes was sized for a single-shape TODO campaign and
the measured evidence says it does not fit these four: `auth-heavy` terminated
*at* the cap having completed 6 of 15 tasks, and #527's `toy` run alone took 72
minutes of wall clock. Because the value flows through the campaign preview into
every bundle's snapshot, evidence always records the budget its run was given —
which raising the constant silently would have destroyed. The enforcement seam
is untouched: ADR 0054 still checks every candidate at dispatch, against a
ceiling that is now supplied rather than assumed.

A green gate is still not a released product. It asserts that four runs reached
`accepted` with eight clean gates; it does not assert that the generated apps are
good. That judgment stays with the UI-quality judge and the operator.
