# ADR 0058: UI quality gate lives inside the browser-verification loop

- Status: Proposed
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
