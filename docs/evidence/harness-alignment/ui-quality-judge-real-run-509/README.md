# UI-quality judge — real full-pipeline run evidence (#509)

#475's own acceptance criteria required "at least one tracer rerun shows judge
output attached to run evidence." #515 supplied a real (non-mock) judge call,
but by invoking `evaluateUiQuality()` directly against a saved screenshot —
its own writeup says a full real-mode tracer run was attempted first and hit
defect #2 (browser-plan sequencing refusal) before ever reaching
browser-verification. #509 exists specifically to close that gap: a real run
that goes past the plan-approval gate, through implementation, and actually
reaches browser verification, so the judge scores real run evidence, not an
isolated function call.

This run did exactly that — five times over.

## Method

A small programmatic driver was added
(`runTracerScenarioToCompletion` in `packages/composition/src/tracer.ts`,
wired into `scripts/tracer.ts` as `--approve-gates`): it auto-approves every
operator-approval gate a run parks at (mirrors `testing-helpers.ts`'s
`approveAllGates`, used by the mock-mode integration suites) instead of
stopping at the first `worker.runOnce()` like the plain tracer CLI did.

Command:

```
RUN_REAL_TRACER=true \
CODEX_DEFAULT_MODEL=gpt-5.6-luna \
CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
EXECUTOR_MODE=real \
npx tsx scripts/tracer.ts --scenario toy --approve-gates \
  --policies-dir <tmp>/509-policies --policy-id ui-judge-real \
  --data-dir <tmp>/509-datadir --executor-mode real
```

`--policies-dir`/`--policy-id` point at a one-off policy
(`schemaVersion: '1'`, `id: ui-judge-real`) that sets
`uiQualityJudge: { provider: claude, model: haiku }` — advisory only,
`minOverallScore` deliberately omitted. Promoting the judge to a *blocking*
gate is `[HA-A.3] (#516, #477)`, which landed on `main` (commit `b14f380`)
after #509 was filed but is explicitly out of scope for this ticket; an
advisory-only policy keeps this run's behavior identical to what #475
shipped. Scenario: `examples/tracer/scenarios/toy.json` (the Counter app),
same scenario #515 used.

Project `01KZW6P1F8V00KNT8K0BR9JTBS`, run `01KZW6P1F9HHTCZCNY8VYXBGCC`,
started `2026-08-12T23:59:51Z`.

## Result: the run reached browser verification, 5 times, with real judge scores

- **T1** (counter table + RLS + increment function) and **T2** (unauthenticated
  counter API routes) both completed cleanly — deterministic checks passed on
  the first attempt for each.
- **T3** ("Make `/` the public counter page and relocate the auth/items demo
  to `/items`") is browser-visible. Its deterministic checks passed twice
  (`verify-task.T3`), but its browser check (`assert-task.T3`) failed on
  every one of 5 attempts over the next ~46 minutes, each time routing
  through the real repair loop (`codex-default`) before re-verifying.
- **On every one of those 5 attempts, the browser-verification.report
  artifact carries a genuine `uiQuality` field**, produced by a real
  `claude-haiku-4-5-20251001` call against real screenshots from a real
  preview session — not a mock, not a scripted executor, not an isolated
  function call:

  | Revision | `approved` | judge `overallScore` | `judgeModel` |
  |---|---|---|---|
  | 1 | false | 0.05 | claude-haiku-4-5-20251001 |
  | 2 | false | 0.00 | claude-haiku-4-5-20251001 |
  | 3 | false | 0.02 | claude-haiku-4-5-20251001 |
  | 4 | false | 0.05 | claude-haiku-4-5-20251001 |
  | 5 | false | 0.02 | claude-haiku-4-5-20251001 |

  Full artifact for revision 5: [`browser-verification-report-rev5.json`](browser-verification-report-rev5.json).

This satisfies #509's outcome ("one real-mode tracer run reaches browser
verification with the UI-quality judge producing a real score") on its own
terms: a real run, past the plan-approval gate, through two fully-passing
implementation tasks and a third's repeated real browser-verify cycles, with
the real judge attaching a real score to real run evidence each time.

## Why every score is near zero — and why that's still good evidence

Every browser-verify attempt this session hit the identical Playwright
navigation failure: `page.goto: net::ERR_BLOCKED_BY_CLIENT` against
`http://127.0.0.1:4000/preview/<sessionId>/`, on every one of the 5 attempts,
regardless of what the repair loop changed in the app. The resulting
screenshot is a Chrome error page, not the app:
[`screenshot-rev5-open-counter.png`](screenshot-rev5-open-counter.png) — a
blank white 1280×720 capture.

The judge was not fooled by this and did not fabricate a plausible-sounding
review: its revision-5 findings read, verbatim, "Both screenshots show a
completely blank white page — no elements, spacing, or hierarchy to
evaluate; the app appears to have failed to render any content" and "reads
as a rendering failure rather than a designed empty state" — an accurate,
specific, screenshot-grounded diagnosis of exactly what the screenshot shows,
across all 5 rubric criteria. That the judge scored a real (if degenerate)
failure state correctly, rather than being a mock stub that returns a fixed
result regardless of input, is itself part of what "real" evidence means
here.

The `net::ERR_BLOCKED_BY_CLIENT` failure is a new observation, distinct from
defect #2 (`docs/evidence/harness-alignment/defect-list.md`) — no
`ExecutionError` was ever raised, the run never crashed, and the repair loop
kept iterating normally. It looks like a browser/Playwright-context-level
block on navigating to the local preview URL rather than an
orchestration-sequencing problem, but this session did not investigate
further (out of scope for #509, and diagnosing it live risks the same
scope-creep #509's own "out of scope" section warns against). Recorded here,
not filed as a numbered defect-list entry, since it wasn't reproduced against
a second independent scenario this session — same evidentiary bar the
existing defect-list entries hold themselves to.

## Why the run stopped short of a terminal status

The driving process was still actively iterating a normal repair cycle
(`quality.repair_requested`, iteration 8) when it was killed externally
~54–60 minutes after start — not a crash, not a stall (events kept landing
every few minutes throughout), and not defect #2. The run never reached
`completed`/`failed`/`rejected`. Per this session's cost guardrail (run once;
retry only after fixing a concrete, identified cause), no second run was
started: the external kill isn't a fixable "cause" in the codebase, and the
evidence goal — a real judge score attached to real run evidence from a run
that reached browser verification — was already satisfied at revision 1 and
held through revision 5, so a second ~hour-long real run would have spent
real money to re-confirm something already proven.

## Cost

All model calls were real (`EXECUTOR_MODE=real`, no mocks). The harness's
own per-role cost metrics (`metrics/models.json` in the run's `DATA_DIR`)
recorded `totalEstimatedCostUsd: 0` for every entry — untracked in this
config, not actually free — so token counts and wall-clock are the honest
cost signal available:

| Role | Model | Attempts | Input tokens | Output tokens | Duration |
|---|---|---|---|---|---|
| planner | claude-opus | 1 | 12 | 25,588 | 5m51s |
| developer (database) | claude-opus | 3 | 4,616 | 59,888 | 14m58s |
| developer (database) | codex-default (gpt-5.6-luna) | 1 | 826,919 | 7,748 | 3m14s |
| tester (verification) | codex-default (gpt-5.6-luna) | 2 | 733,858 | 12,649 | 4m26s |
| fixer (repair) | codex-default (gpt-5.6-luna) | 3 | 10,345,582 | 41,269 | 18m53s |
| UI-quality judge | claude-haiku-4-5-20251001 | 5 | (not separately metered — bypasses the routed-agent pipeline, ADR 0058) | — | — |

Model routing picked `claude-opus` for planning/implementation despite
`CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001` — that env var only overrides
the `claude-haiku` catalog entry's model string, not which catalog entry the
router selects; `claude-opus`, `claude-sonnet`, and `claude-haiku` are all
`enabled: true`/`requireExplicitModel: false` in `models/catalog.yaml`, so
the capability-weighted router chose opus on its own. Worth knowing before
budgeting a future real run off this one.

Total wall-clock: ~54–60 minutes for the driving process (real API +
provisioning + repair-loop time), before external termination.

## ADR 0058

Already `Status: Accepted` on `main` — flipped by `[HA-A.3] (#516, commit
b14f380)`, which landed after #509 was filed. No change made by this PR;
noted here since #509's own outcome list asked for it.

## Scope note

Not new #475/#477 scope. The judge and its (now-optional) blocking gate are
unchanged by this PR — this only supplies the full-pipeline real-run evidence
artifact #509 asked for, plus the small `--approve-gates` driver needed to
produce it.

## Resolution: the near-zero scores measured a Chrome error page, not app quality (#526, #528)

The `net::ERR_BLOCKED_BY_CLIENT` failure noted above ("Why every score is near
zero") was investigated and fixed by #526 (this run's specific instance) and
#528 (the general class), branches `fix/526-528-browser-infra` and
`fix/526-tracer-preview`. Root cause, in two parts:

1. **The error code was a lie.** `PlaywrightBrowserVerifier`'s route handler
   wrapped `route.fetch()` in a bare `catch` that rewrote *every* transport
   failure — connection refused, DNS, socket reset — into
   `route.abort('blockedbyclient')`, the same abort code its two deliberate
   `permitted()` policy-block branches use. Chrome then reports
   `net::ERR_BLOCKED_BY_CLIENT` for both a genuine policy block and a
   completely dead origin, indistinguishably. Fixed in `fix/526-528-browser-infra`
   (commit `bb6b2bd`): a transport failure is now recorded as a
   `preview-unreachable` observation with the real cause (e.g. `ECONNREFUSED`)
   and surfaces as `infrastructureFailure` on the report; `blockedbyclient` is
   now emitted only by the two deliberate policy-block branches.
2. **Nothing was listening at `http://127.0.0.1:4000`.** The preview URL this
   run's browser step navigated to is built as
   `http://${apiHost}:${apiPort}/preview` (`packages/composition/src/runtime.ts`)
   and is served by `apps/api`'s preview proxy — a separate HTTP server.
   `scripts/tracer.ts` builds the runtime and drives the worker in-process; it
   never starts that server. This run's `--data-dir`/`--policies-dir` driver
   had no API process running alongside it, so every one of the 5
   browser-verify attempts navigated to an origin nothing was serving. Fixed
   in `fix/526-tracer-preview`: the tracer driver now probes the configured
   preview origin with a plain TCP connect before a real-mode run starts, and
   fails in seconds — naming the origin — instead of discovering it 46-60
   minutes and 5 repair-loop iterations later.

**The screenshots this run captured were a `chrome-error://chromewebdata/`
page, not the counter app.** The judge's near-zero scores (0.00-0.05 across
all 5 revisions) are an accurate read of that blank error page, not a defect
in `evaluateUiQuality()` or the rubric — see "Why every score is near zero"
above, which already documents the judge correctly identifying the blank
page rather than fabricating a plausible review. Nothing about the judge
itself needed changing.

A real-mode re-run against a corrected pipeline (API server actually up, so
the browser step reaches the real app) is #527, gated on `fix/526-tracer-preview`
merging, and explicitly out of scope for both #526 and this note.
