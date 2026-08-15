# ADR 0067: Performance budgets for the builder, and its pane-state primitive

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

The same branch also converges on one UI decision that recurs across its tasks: how every pane
in the builder renders the three states it can be in when it has no content to show — nothing
yet, still loading, or failed. Before this branch there was one primitive, `EmptyState`, that
covered only the first, and each pane improvised the other two. That is an implementation
detail of another task on this branch (Task 1), so this ADR is where its rationale is recorded
rather than scattered across task PRs.

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

### 2. One presentational `PaneState` primitive replaces `EmptyState` and five ad hoc patterns

`apps/web/components/pane-state.tsx` exports a single presentational component taking a
`kind: 'empty' | 'loading' | 'error'`, a `title`, and optional `hint` (a string), `children`,
`action` and `persistent`. It has no state of its own and knows nothing about which pane it is
in; it is what a pane renders in place of content. It replaces `EmptyState` — which only
covered "nothing to show" — and the five ad hoc sites that had grown around it: a bare
`<p className={HINT}>` standing in for a loading state, a `<p role="alert" className={ERROR_BOX}>`
for an error, `EmptyState title={error}` misused to render a failure as if it were emptiness,
and two panes where loading was visually indistinguishable from empty.

The point of making `kind` the input rather than the caller picking a wrapper is that `kind`
is what decides the live-region semantics, and getting those right by hand at each site is
what had been failing:

- `empty` — no role. Nothing happened; there is nothing to announce.
- `loading` — `role="status"` plus `aria-busy`, so it is announced politely, once.
- `error` — `role="alert"`, assertive, because a failure the user just caused should
  interrupt.

`persistent` exists for the one case that breaks that mapping: state already true on first
render, such as the preview-failure card showing a previous run's broken preview. It suppresses
the assertive role so a screen reader is not interrupted on page load. `children` exists so a
stack trace can keep its monospace `<pre>` with a height cap, instead of being flattened into
the `hint` prose slot.

Colour follows the same reasoning: `error` uses `--ink` text on a `bg-err/10` wash rather than
`text-err`, which measures 3.44:1 against DESIGN.md §7's 4.5:1 floor.

### 3. Inherited context: below `lg`, panes stack

Not a decision of this branch. The builder's panes already stacked vertically below the `lg`
breakpoint, from DESIGN.md §10's Task 5 migration. What this branch added is verification: the
390px overflow probe in `apps/api/e2e/golden-flow.spec.ts` asserts the stacked layout does not
scroll horizontally and keeps each surface's primary action reachable. It is recorded here only
so a reader of §2 does not mistake the stacking behaviour for something §2 introduced. Full
responsive parity with the desktop three-pane layout at every viewport remains out of scope —
the builder's target is a solo developer's desktop tool (`docs/PRODUCT_CONTRACT.md`).

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
- **Add a `tone` prop to `EmptyState` and keep the name.** Rejected — the component would then
  render loading and error states under a name that says "empty", and the name is what call
  sites read. Renaming it to `PaneState` is the same diff plus a rename, and it makes the
  misuse (`EmptyState title={error}`) impossible to reproduce by copying a neighbour.
- **Keep `EmptyState` as an alias for the `kind="empty"` case.** Rejected — it would have made
  the migration a smaller diff, but new call sites would keep reaching for it, and the whole
  point is that a pane author is confronted with the three states rather than the one.
- **Widen `hint` to `ReactNode` instead of adding `children`.** Rejected — `hint` carries a
  `max-w-[42ch]` prose measure, which is right for a sentence of explanation and wrong for a
  stack trace that needs monospace and its own scroll cap. Two slots with different
  constraints, not one slot that has to be right for both.

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
