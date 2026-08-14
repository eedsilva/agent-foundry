# ADR 0058: UI quality gate lives inside the browser-verification loop

- Status: Accepted
- Date: 2026-08-08
- Owners: Core, UX
- Tracked by epic #469 (build tickets #475, #477)

## Context

Generated apps pass deterministic checks and browser verification, yet their UI quality is
unjudged: verification asserts behaviour, not coherence, hierarchy, or visual sanity. The one
accepted end-to-end run (TODO tracer) proved the loop, not the output quality. A quality
signal must gate generation for any app shape, not just the golden app.

Alternatives considered: a separate harness stage with its own contract and artifacts
(cleaner seam, higher build cost), and scaffold-only investment without enforcement (no
regression protection).

## Decision

Extend the existing Chromium browser-verification loop with a UI-quality rubric/judge stage.
The rubric is a versioned artifact; the judge's report reuses the browser-verification
report contract (JSON-only, screenshot-referencing, plan-linked). It ships advisory first
and is promoted to a blocking gate wired into the repair loop once its false-positive rate
is understood from multi-shape tracer evidence.

## Consequences

- Reuses plan/report contracts, screenshot capture, and repair wiring; no new stage in the
  operation pipeline.
- Rubric versioning becomes part of the verification contract surface.
- Promotion to blocking is a data-driven follow-up decision, not part of this ADR.
- The judge is opt-in per project: an optional `uiQualityJudge` field on `ProjectPolicy`, shaped
  `{ provider: <Provider>, model: <string> }`. Absent, the judge never runs. A project opts in by
  setting this field in its own policy. (Superseded for the shipped default by the #549 update
  below: `policies/default.yaml` now sets the field.)

## Update (2026-08-12, #477)

The judge is promoted to an optional blocking gate via `ProjectPolicy.uiQualityJudge.minOverallScore`
(issue #477). This field is optional; absence keeps the judge purely advisory, preserving
backward compatibility with every pre-#477 policy. When configured, a report whose
`uiQuality.overallScore` falls below the threshold causes `gateOnUiQuality` to flip the existing
`approved` field to `false`, routing the run through browser repair without adding a parallel
gate or new event kind. Repair and emergency-ceiling mechanics are 100% reused; gate-caused
failures are indistinguishable at those call sites from functional failures.

Threshold selection is data-driven: HA-A.1's real judge run (`docs/evidence/issue-475-ui-quality-judge/judge-result.json`)
scored the post-#476 scaffold `overallScore: 0.43`; thresholds must sit clearly below that. An
induced-ugly integration test (`packages/composition/src/ui-quality-judge.integration.test.ts`,
#477 describe block) demonstrates the repair loop with an example threshold of 0.3: first
browser-verify scores 0.1 (below threshold), triggering repair, then 0.8 (above), approving the
run. Evidence for this update is logged at `docs/evidence/issue-477-ui-judge-gate/README.md`.

The gate is best-effort, not fail-closed: `judgeUiQuality` swallows every failure (judge outage,
timeout, no screenshots) and returns `undefined`, and `gateOnUiQuality` leaves `approved` exactly
as functional verification computed it when `uiQuality` is `undefined` — a judge outage never
blocks a run. Separately, a `blocksOnFailure: true` browser-verify step (no shipped workflow
defines one today) hard-fails the run rather than repairing on `approved: false`, whether that
`false` came from a functional failure or from this gate — a future workflow author wiring one up
should expect a UI-quality shortfall to be able to trigger a hard run failure there, not just a
repair.

## Update (2026-08-14, #549)

`policies/default.yaml` now sets `uiQualityJudge: { provider: claude, model: haiku }` and bumps to
`version: 2`. Until this, no shipped configuration set the field at all, so `judgeUiQuality`
returned `undefined` on every real run and the #477 gate was dead code. Every project defaults to
`policyId: 'default'`, so the bundled file was the only thing standing between an install and a
judge that never ran.

`minOverallScore` is deliberately omitted: the judge scores and annotates, `gateOnUiQuality`
returns the report untouched, nothing blocks. A threshold cannot be chosen responsibly yet — the
only real-mode data point is #527's working app at `overallScore: 0.55` (per-criterion 0.35-0.8,
`docs/evidence/harness-alignment/ui-quality-judge-rendered-app-527/`). Against one point, `0.3` is
nearly a no-op and `0.6` would have blocked a working app. Shipping advisory accrues scores as a
side effect of normal usage, at zero blocking risk, and the threshold gets picked later from that
corpus. Choosing it is a follow-up; epic #469 cannot fully close until it lands.

Cost: one extra model call per browser verification on real runs. `claude` + `haiku` is what #527
used, and it produced specific, screenshot-grounded findings — the cheap model is demonstrably
adequate for this job. In mock mode `MockAgentExecutor` answers the judge call, so it costs nothing
there. Note the call bypasses `StepAttempt` persistence by design (see `judgeUiQuality`), so its
`usage` is not counted by anything that rolls attempts up — budget and cost reporting will
under-report real runs by one haiku call per browser verification.

Upgrade note: editing the shipped policy changes its hash, and the orchestrator throws
`policyChanged` when a run's recorded `policy.hash` no longer matches
(`workflow-orchestrator.ts`). A run that is paused or queued across this upgrade therefore fails at
its next boundary rather than resuming. That is the existing, intended behavior for any policy
edit, not something this change introduces — but it is the first edit to `policies/default.yaml`
since it shipped, so it is the first time operators will meet it. Drain in-flight runs before
upgrading, or roll back by restoring `version: 1` and dropping the `uiQualityJudge` block.
