# Performance budgets

Two budgets, enforced in CI. Both are deterministic — byte-exact or a layout measurement —
which is why they are the only two. See ADR
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

### Measured baseline (2026-08-15, this branch, production build)

| Route            | Measured First Load JS | Budget  | Headroom |
| ----------------- | ----------------------: | ------: | -------: |
| `/`                | 548.9 KB                | 635 KB  | 86.1 KB  |
| `/project/[id]`    | 988.9 KB                | 1140 KB | 151.1 KB |
| `/router`          | 913.5 KB                | 1055 KB | 141.5 KB |

Budgets are the measured baseline plus roughly 15% headroom, rounded up to the nearest 5 KB.
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
(what the golden-flow e2e runs against) as it does against a production build. That is why it
is budgeted and LCP/INP/TTFB are not — see below.

## What is explicitly NOT budgeted, and why

**LCP, INP and TTFB are not budgeted.** The golden-flow e2e runs the app under `next dev`
(`golden-flow.spec.ts:181`), where those numbers reflect on-demand compilation of an
unminified bundle on a shared, variably-loaded CI runner. A budget on any of them would be
measuring CI runner noise, not the product — pure flake, not signal. If a production timing
budget is ever wanted, it needs its own measurement path against a production build (e.g. a
Lighthouse CI run), not the golden-flow e2e.

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
