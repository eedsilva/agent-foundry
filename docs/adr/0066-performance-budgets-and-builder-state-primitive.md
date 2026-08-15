# ADR 0066: Performance budgets for the builder, and its two UI-state primitives

- Status: Proposed
- Date: 2026-08-15
- Owners: UX
- Tracked by issue #97 (builder polish: accessibility, responsiveness, performance)

## Context

Issue #97 is the accessibility/responsiveness/performance polish pass on `apps/web`'s
builder. Before this branch, nothing measured performance: no bundle-size gate, no layout-shift
gate, and the one e2e suite that does run an accessibility scan
(`apps/api/e2e/golden-flow.spec.ts`, which asserts axe against five surfaces) executed in CI
only as a subprocess of `supabase-data-plane-e2e` — a job that needs Docker and the Supabase
CLI and is red on `main`. That made it the sole CI path exercising the axe scan, so every
accessibility assertion added on this branch would have landed unenforced.

The same branch also converges on two UI-state decisions that recur across its tasks: how the
builder's three panes (Chat, Preview, Inspector) represent "hidden vs. visible" as a single
primitive rather than ad hoc booleans, and how those panes degrade below the `lg` breakpoint
on a narrow viewport. Both are implementation details of other tasks on this branch (builder
shell state, responsive layout); this ADR is where their rationale is recorded so it isn't
scattered across task PRs.

## Decision

### 1. Two performance budgets, both deterministic in CI

- **Client bundle size (First Load JS) per route**, read from `next build`'s own
  `apps/web/.next/diagnostics/route-bundle-stats.json` and checked against
  `perf-budgets.json` by `scripts/check-perf-budgets.mjs` (`npm run perf:check`), wired into
  the existing `build` CI job right after `npm run build`. Byte-exact, not timing-dependent —
  this catches the real regression (someone importing a heavy library into the builder).
- **Cumulative Layout Shift (CLS) on the golden flow**, budgeted at the standard "good"
  threshold of `0.1` in the same `perf-budgets.json`, asserted by
  `apps/api/e2e/golden-flow.spec.ts`. CLS is a layout measurement, so it means the same thing
  under `next dev` (what the golden-flow e2e runs) as it does in production — unlike LCP, INP
  or TTFB, which are explicitly **not** budgeted because the e2e runs against on-demand
  compilation of an unminified bundle on a shared CI runner; a budget on them would be pure
  flake, not signal.
- `golden-flow.spec.ts` gets its own `golden-flow-e2e` CI job, modelled on the existing
  `issue-radar-e2e` job, so the axe scan (and the new CLS assertion) runs on every PR without
  requiring Docker or Supabase. `supabase-data-plane-e2e` is left as-is; this job makes it no
  longer the only route that executes the suite.
- See `docs/PERFORMANCE_BUDGETS.md` for the measured baselines, the budgets, and how to raise
  one deliberately.

### 2. A single `PaneState` primitive replaces boolean per-pane flags

The builder shell's three panes (Chat, Preview, Inspector) and the simple/Advanced split
introduced by ADR 0061 are represented as one `PaneState` value per pane rather than
independent `isOpen`/`isCollapsed`/`isAdvanced` booleans. A pane's visibility and its
interaction with the Advanced toggle are one fact, not several flags that can drift out of
sync (e.g. a pane marked both closed and expanded). `EmptyState`, the ad hoc placeholder
component previously used piecemeal per pane, is retired in favor of this single primitive
driving what each pane renders when it has nothing to show.

### 3. Below `lg`, panes stack instead of squeezing into columns

On viewports narrower than the `lg` breakpoint, the builder's panes stack vertically instead
of staying side-by-side at a width too narrow to be usable. This is a deliberate degradation,
not a missing feature: the builder's target is a solo developer's desktop tool
(`docs/PRODUCT_CONTRACT.md`), so a working stacked layout below `lg` is the accepted floor —
full responsive parity with the desktop three-pane layout at every viewport is out of scope.

## Considered Options

- **Time-based performance budgets (LCP/INP/TTFB) instead of, or alongside, bundle size and
  CLS.** Rejected — the only place these could be measured in CI is the golden-flow e2e
  against `next dev`, where they reflect runner load and dev-mode compilation, not the
  product. A production-build timing budget (e.g. Lighthouse CI) is a different measurement
  path and out of scope here.
- **A new CI job for the perf-budget check.** Rejected — the existing `build` job already
  produces exactly the artifact (`apps/web/.next/diagnostics/route-bundle-stats.json`) the
  check needs; a separate job would just rebuild the same thing.
- **Fix `supabase-data-plane-e2e` instead of adding a second job that also runs
  `golden-flow.spec.ts`.** Rejected — out of scope for #97; the new `golden-flow-e2e` job gets
  the accessibility scan enforced without taking on that job's Docker/Supabase flakiness.
- **Keep per-pane booleans, add a lint rule against invalid combinations.** Rejected — a lint
  rule polices a representation that can still hold contradictory state; a single `PaneState`
  value makes the contradiction unrepresentable instead.
- **Overlay/drawer panes at narrow viewports instead of stacking.** Rejected for the same
  reason ADR 0061 rejected an overlay for Inspector: a new component class (z-index, backdrop,
  animation) for a viewport this product's target user is unlikely to use.

## Consequences

- A budget nobody can trace back to a measurement gets raised on the first failure instead of
  investigated — `docs/PERFORMANCE_BUDGETS.md` records the exact measured baseline behind each
  number so a raise is a deliberate, justified PR, not a reflex.
- `next build`'s stdout no longer prints a "First Load JS" table under Next.js 16.2 with
  Turbopack; the check reads structured JSON instead. If a future Next.js upgrade changes or
  removes `apps/web/.next/diagnostics/route-bundle-stats.json`, `scripts/check-perf-budgets.mjs`
  needs a new source — it already fails loudly rather than silently passing if that file goes
  missing, so the break will be visible in CI rather than silent.
- `DESIGN.md`'s migration table (§10, row 7) is updated to name what this branch actually
  verifies (WCAG 2.2 AA via axe on five surfaces, a 390px overflow probe, and these two
  budgets) rather than the older "contrast AA verified, ≤1000px collapse tested" wording.
- Explicitly out of scope: LCP/INP/TTFB budgets under any measurement path, full responsive
  parity below `lg`, and fixing `supabase-data-plane-e2e`.
