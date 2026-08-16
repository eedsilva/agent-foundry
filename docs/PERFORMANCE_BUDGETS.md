# Performance budgets

Three budgets, enforced in CI. They cover bundle bytes, layout shift, and the browser's
navigation/interaction timings. See ADR
[0067](adr/0067-performance-budgets-and-builder-state-primitive.md).

## 1. Client bundle size (First Load JS)

Source of truth: [`perf-budgets.json`](../perf-budgets.json) (`firstLoadJsKb`), checked by
[`scripts/check-perf-budgets.mjs`](../scripts/check-perf-budgets.mjs) (`npm run perf:check`),
wired into CI as the last step of the `build` job in `.github/workflows/ci.yml`, right after
`npm run build`.

`next build` (Turbopack, Next.js 16.2) no longer prints a "First Load JS" column to stdout —
the route table it emits carries only the route list. The number does still exist, as
structured JSON, at `apps/web/.next/diagnostics/route-bundle-stats.json`: an array of
`{ route, firstLoadUncompressedJsBytes, firstLoadChunkPaths }`, one entry per route, written
by the build itself. `scripts/check-perf-budgets.mjs` reads that file rather than scraping
stdout — it is the same computation Next's own CLI table used to print, just relocated, and
parsing it is exact where scraping a human-formatted table is not.

The check fails loudly, not silently, in two cases the brief specifically calls out as
must-not-pass:

- `apps/web/.next/diagnostics/route-bundle-stats.json` is missing (no build ran) — the script
  exits 1 and tells you to build first, rather than reporting "0 breaches."
- A route named in `perf-budgets.json` is absent from the manifest (e.g. the route was
  renamed or removed) — treated as a breach, not skipped.

### Measured baseline (2026-08-15, production build of the whole `#97` branch)

Re-measured after every task on the branch had landed. The first numbers recorded here were
taken in a worktree that predated Tasks 1-3, and drifted by 0.3-2.9 KB as those merged.

| Route           | Measured First Load JS | Budget  | Headroom |
| --------------- | ---------------------: | ------: | -------: |
| `/`             |               549.2 KB |  635 KB |  85.8 KB |
| `/project/[id]` |               991.8 KB | 1140 KB | 148.2 KB |
| `/router`       |               913.9 KB | 1055 KB | 141.1 KB |

The budgets themselves are unchanged: they are the original measured baseline plus roughly 15%
headroom, rounded up to the nearest 5 KB, and they still hold with ample room. Re-deriving them
from a baseline that moved a couple of KB is exactly the reflex the section below warns about.
`/project/[id]/versions` and `/validation` are not budgeted — they were not named in the
issue's criterion and can be added the same way if they start mattering.

### Raising a budget deliberately

A budget nobody can trace back to a measurement gets raised on the first failure instead of
investigated — don't do that. To raise one: measure the new baseline the same way (`npm run
build --workspace @agent-foundry/contracts && npm run build --workspace @agent-foundry/domain
&& npm run build --workspace @agent-foundry/web`, then read
`apps/web/.next/diagnostics/route-bundle-stats.json`), update `perf-budgets.json` and the
table above together, and say in the PR description what the regression was and why it's
acceptable (a genuinely necessary new dependency, not "the check was in the way").

## 2. Cumulative Layout Shift (CLS) on the golden flow

Source of truth: `perf-budgets.json` (`cls.builder`, currently `0.1` — the standard "good"
CLS threshold). Asserted by `apps/api/e2e/golden-flow.spec.ts` (added in the task that follows
this one, issue #97 Task 5), which reads the same `perf-budgets.json` this task ships.

CLS is a layout measurement, not a timing one, so it means the same thing under `next dev`
(what the golden-flow e2e runs against) as it does against a production build. The Web Vitals
section below records the complementary timing budgets with intentionally broad dev-server
thresholds.

## 3. Web Vitals on the golden flow

Source of truth: `perf-budgets.json` (`webVitals.builder`), asserted by
`apps/api/e2e/golden-flow.spec.ts`. The golden flow records native browser timings after the
same interaction sequence on every PR: TTFB from `PerformanceNavigationTiming`, LCP from the
largest-contentful-paint entry, and INP from the observed event durations. The budgets are
deliberately generous for the dev-server test path (2000ms / 5000ms / 500ms) but fail when a
regression makes a metric unavailable or slower than its limit.

## CI wiring — golden-flow-e2e job

Before this task, `golden-flow.spec.ts` (which includes the axe accessibility scan across the
issue #97 branch's five surfaces) ran in CI only as a subprocess of the
`supabase-data-plane-e2e` job — which needs Docker and the Supabase CLI, and is red on `main`.
That made it the *only* CI path that ever executed the axe scan: every accessibility assertion
landed in Tasks 1-5 was unenforced.

The suite itself needs neither Docker nor Supabase. Standalone, after `npm run build:packages`:

```
$ npm run build:packages && npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts
...
4 passed (35.4s)
```

`.github/workflows/ci.yml` now has a dedicated `golden-flow-e2e` job, modelled on the existing
`issue-radar-e2e` job: `needs: preflight`, checkout, setup-node, `npm ci`,
`npx playwright install --with-deps chromium`, `npm run build:packages`, then
`npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts`. `supabase-data-plane-e2e`
is left as-is — fixing it is out of scope for #97 — but it is no longer the only route that
runs this suite.
