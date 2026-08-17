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
`supabase-data-plane-e2e` job — which needs Docker and the Supabase CLI, and intermittently
fails under load. That made it the *only* CI path that ever executed the axe scan: every
accessibility assertion landed in Tasks 1-5 was unenforced.

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

### Measured status of `supabase-data-plane-e2e` — 2026-08-17 (#575)

The paragraph above used to say this job "is red on `main`". That was false, and it was
load-bearing: it is the stated reason `golden-flow-e2e` exists, so the next person reading it
was told the Docker/Supabase job is known-red — the exact belief that waves off a real failure.
It cost real time on #571/#573, where it was the first evidence suggesting "known flake".

**Pass rate.** Across the last 40 `ci` workflow runs (2026-08-14 → 2026-08-17 UTC): 37 green,
1 red, 2 cancelled, counting only each run's latest attempt. That view hides re-runs, which is
where most of the failures are — six of those runs have more than one attempt. Counting *every*
attempt gives **45 verdicts: 39 green, 6 red**.

| Run | Event | Branch | Result |
| --- | --- | --- | --- |
| `31901468228` | `push` | `main` | red, single attempt |
| `31981326099` a1, a2 | `pull_request` | `fix/571-defer-blocked-browser-plan` | red, green on a3 |
| `31961529103` a1 | `pull_request` | `fix/560-supabase-local-bootstrap` | red, green on a2 |
| `31960483023` a1 | `pull_request` | `feat/97-builder-polish` | red, green on a2 |
| `31902849819` a1 | `pull_request` | `fix/546-restrictive-drop-policy` | red, green on a2 |

**The `pull_request` correlation holds** (AC 2 of #575): 5 of 6 failures are `pull_request`
runs, where CodeQL and `dependency-review` run alongside `ci`. The lone `main` failure means
the correlation is not an absolute — a `push` run can lose too — so "PR-only" is too strong,
but "PR-correlated" is what the data says. **No failure is reproducible at its own commit:**
every re-run above is green at the *identical* head SHA, matching the local result (33s, green)
and the `workflow_dispatch` re-runs on #573.

**The failure shape is identical in all six**, and it is one test, not two:

```
✘ golden-flow.spec.ts:986  golden flow: attach reference, plan, build, visual edit, revert, rebuild
    Error: page.waitForResponse: Test timeout of 180000ms exceeded.
✘ golden-flow.spec.ts:1302 router dashboard shows decisions and filters…
    Error: Timed out waiting for http://localhost:<port>     ← the `next dev` it took down
2 failed / 1 did not run / 1 passed
```

The heaviest test blows the 180s Playwright budget (`apps/api/e2e/playwright.config.ts:5`) at
`page.waitForResponse`; the next test then fails waiting for the dev server the first one took
with it, and the fourth never runs. Locally the whole spec needs ~33s, so 180s is not a
marginal budget — it is ~5x headroom that a loaded runner still exhausts.

**No timeout was raised.** With every failure green at its own SHA and 5x headroom already, a
larger budget would as likely mask a real regression as fix a flake. The correlation points at
the other lever #575 names — reducing what runs concurrently on `pull_request` events — which
is a change to CodeQL/`dependency-review` scheduling, out of scope for a documentation fix.

Read a red check here before re-running it: per `docs/VALIDATION.md` ("CI-caught regression:
transient `unhealthy` blips…"), a same-named failure on an unrelated branch has already turned
out to be a different, real bug.

One superlative to avoid while rewriting this: it is not the heaviest job in CI. On green
`main` runs it takes 242–269s, behind `test` (658–700s) and `issue-radar-e2e` (312–333s). What
is distinctive about it is the dependency stack (Docker, a real Supabase, a spawned dev server)
and its sensitivity to load — not wall clock.
