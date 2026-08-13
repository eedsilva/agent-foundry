# UI-quality judge — real-mode score against an app that actually rendered (#527)

#509 proved the judge attaches a real score to real run evidence, but every
score it captured was 0.00–0.05 because every screenshot was a Chrome error
page (#526). The rubric had therefore never been shown to *discriminate* a
working UI from a broken one, and the blocking gate #516 introduced had no
known baseline on a healthy app. That is the gap this closes.

**Headline: the judge scored `0.55` on an app that rendered, against `0.00–0.05`
on #509's blank pages, with per-criterion findings that describe what is
actually on screen.** The rubric discriminates.

## Method

Same driver as #509 — `runTracerScenarioToCompletion`
(`packages/composition/src/tracer.ts`), reached from `scripts/tracer.ts` via
`--approve-gates` — on the same `toy` (Counter) scenario.

One thing differs from #509, and it is why the preview loaded this time:

**The API server was running, sharing the tracer's `DATA_DIR`.** The tracer
builds preview URLs against `apiHost:apiPort` but never starts the API itself.
The proxy resolves a session through *its own* runtime —
`runtime.previewService.resolveUpstream(sessionId, token)`
(`apps/api/src/preview-proxy.ts:97`) → `<DATA_DIR>/previews/<id>/session.json`
— so an API on a different `DATA_DIR` 404s every preview navigation while
#526's TCP preflight still passes. Both processes were pointed at the same
absolute `--data-dir`.

Commands:

```
# terminal 1 — preview proxy, same DATA_DIR as the tracer
DATA_DIR=<abs>/527-datadir POLICIES_DIR=<abs>/527-policies \
API_HOST=127.0.0.1 API_PORT=4527 RUN_WORKER_INLINE=false \
EXECUTOR_MODE=real PREVIEW_REAP_INTERVAL_MS=86400000 \
CODEX_DEFAULT_MODEL=gpt-5.6-luna CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
npx tsx apps/api/src/index.ts

# terminal 2 — the run (also exported AUTO_INSTALL_DEPENDENCIES=true, which the
# tracer overrides to 'false' in startTracerRun, so it had no effect)
RUN_REAL_TRACER=true EXECUTOR_MODE=real \
CODEX_DEFAULT_MODEL=gpt-5.6-luna CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
DATA_DIR=<abs>/527-datadir API_HOST=127.0.0.1 API_PORT=4527 \
npx tsx scripts/tracer.ts --scenario toy --approve-gates --executor-mode real \
  --policies-dir <abs>/527-policies --policy-id ui-judge-527 \
  --data-dir <abs>/527-datadir
```

The API was up and healthy at `16:25:01Z`, before the tracer's first event
(`project.created`, `16:25:09Z`). It was then **restarted at `16:26:22Z`** — a
minute into the run, ~39 minutes before the first preview navigation
(`17:05:17Z`) — to add `PREVIEW_REAP_INTERVAL_MS=86400000`. That restart was a
precaution taken on a misreading of the lifecycle lock, and is documented here
only so the command block matches what actually ran. It was not needed: the
reaper cannot steal a starting session's lock. `reap()` acquires the *same*
per-session lock as `PreviewService.start`
(`packages/orchestrator/src/preview-service.ts:267-268`), and
`DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS` (180s,
`packages/persistence/src/preview-repositories.ts:37`) is an *acquisition*
timeout for the waiter, not an expiry on the holder — a waiter that misses the
deadline throws `Timed out acquiring lock`
(`packages/persistence/src/fs-utils.ts:296`), and `recoverAbandonedLock` only
reclaims a lock whose owner PID is dead. A slow boot therefore makes the
reaper's sweep fail, not the boot; it never reaches the `preparing`/`starting`
orphan branch while the starting process is alive.

Policy `ui-judge-527` (`schemaVersion: '1'`). Per #509's README its policy set
`uiQualityJudge: { provider: claude, model: haiku }` and deliberately omitted
`minOverallScore`; this one adds the threshold:

```yaml
uiQualityJudge:
  provider: claude
  model: haiku
  minOverallScore: 0.3
```

Project `01KZXZ25Q9FEZPC9PTY8ZM0DZ8`, run `01KZXZ25QBGDF0HFAWEHSDJGPH`,
started `2026-08-13T16:25:09Z`, last event `2026-08-13T17:37:33Z`.
A prior mock-mode run of the same scenario, policy, and driver flags validated
the wiring at zero cost before any money was spent.

## Result: the preview loaded and the judge scored the rendered app

The run produced two `browser-verification.report` revisions, from two
different browser plans against two live preview sessions.

| Rev | Verifier | Preview session | `approved` | Judge score |
|---|---|---|---|---|
| 1 | `assert-task.T4` | `01KZY1B9XHFWWCA6ZNH8NVVH9S` (`running`) | true | **0.55** (`claude-haiku-4-5-20251001`) |
| 2 | `assert-task.T6` | `01KZY3200VZG12KJK4P79DAXR5` (`running`) | true | none — judge outage, see below |

Both sessions reached `status: running` and the browser navigated to
`http://127.0.0.1:4527/preview/<sessionId>/` successfully. No
`ERR_BLOCKED_BY_CLIENT`, no `preview-unreachable`, no infrastructure failure.

### Revision 1 — scored `0.55`, six screenshots reviewed

Full artifact: [`browser-verification-report-rev1.json`](browser-verification-report-rev1.json).

| Criterion | Score |
|---|---|
| layout-coherence | 0.55 |
| navigation | 0.35 |
| empty-loading-error-states | 0.5 |
| contrast-readability | 0.8 |
| responsive-sanity | 0.5 |
| **overall** | **0.55** |

The findings are grounded in the pixels, and verifiably so — verbatim:

> **layout-coherence (0.55)** — "Sign-in form has consistent label/input/button
> spacing and alignment, but the public root page shows a heading and
> description referencing a counter and 'Increment button' that never renders —
> the described interactive element is absent, leaving a large empty page with
> no visual hierarchy anchor."
>
> **navigation (0.35)** — "No header, logo, nav links, or breadcrumbs appear in
> any screenshot. The protected-route redirect to sign-in happens silently with
> no banner explaining why the user landed there, and there's no visible path
> back to the public page."
>
> **empty-loading-error-states (0.5)** — "The 'Invalid login credentials' error
> is rendered in a clear, distinctly colored line above the submit button, which
> is good. However, no loading/pending indicator is visible on submit, and the
> counter page's missing button is an unstated empty/broken state rather than an
> explicit placeholder."
>
> **contrast-readability (0.8)** — "Form labels and input text are near-black on
> white (strong contrast); the error message uses a readable red. The counter
> page's descriptive paragraph uses a lighter gray that is legible but noticeably
> lower contrast than the rest of the UI."
>
> **responsive-sanity (0.5)** — "All six screenshots appear to be the same
> desktop viewport size, so no evidence is available to confirm or refute
> behavior at narrower breakpoints; cannot verify responsive layout adaptation
> from this evidence alone."

Check those against the screenshots the judge was handed. Two of the six are
committed here (the six are five distinct images — `protect-items-route` and
`open-sign-in` are byte-identical, `sha256 157a2fbe…`), all `1280×720`:
[`screenshot-rev1-open-public-root.png`](screenshot-rev1-open-public-root.png)
is the public root mid-build — heading "Counter", body copy that literally
reads "The shared count and its Increment button are not wired up yet", and
no button. [`screenshot-rev1-submit-and-assert-tenancy.png`](screenshot-rev1-submit-and-assert-tenancy.png)
is the sign-in form with the red "Invalid login credentials" line above the
submit button.

Every claim checkable against those two images holds, including the subtle one
— that the page *describes* an Increment button it does not render. (The
navigation finding's "in any screenshot" spans all six, four of which are not
committed here; the uniform-viewport claim behind `responsive-sanity` is
confirmed by the `1280×720` dimensions.) This is the discrimination #509 could
not demonstrate.

The single advisory step failure (`submit-and-assert-tenancy`,
`locator.waitFor: Timeout 10000ms exceeded`) is a seeded-tenancy assertion, not
a rendering or infrastructure fault; passive signals were clean.

### Revision 2 — the finished app works, but the judge was rate-limited

Rev 2 is the counter journey, and every functional step passed:
`open-counter`, `increment-once`, `increment-twice`, `increment-thrice`,
`reload-persisted-count`.
[`screenshot-rev2-reload-persisted-count.png`](screenshot-rev2-reload-persisted-count.png)
shows the finished app rendering a count of **3** *after a reload* — the
scenario's acceptance sketch ("clicking Increment 3 times shows 3"; "reloading
after incrementing still shows the incremented value") satisfied against a real
Supabase stack.

Five screenshots were captured for that revision (all `375×667`), but the report
carries no `uiQuality` field. The judge-specific cause appears once in the
retained run log:

```
UI-quality judge failed: claude CLI exited with code 1: You've hit your session
limit · resets 5pm (America/New_York)
```

An account-level rate limit on the judge's own CLI — not a judge defect, not a
screenshot problem, not a preview problem. The same limit is recorded twice more
in `events.jsonl` as `agent.failed`, against `implement.T6` (`17:19:38Z`) and
`implement.T7` (`17:35:24Z`), both on `claude-opus`: it degraded the tail of the
run generally, not just the judge.

The competing explanation is ruled out by the log line itself. A zero-screenshot
call returns early with no log line at all, and the schema-mismatch paths emit
different strings; only the catch-all in
`packages/orchestrator/src/ui-quality-judge.ts` emits this prefix. The report
also lists five screenshots.

This is the documented contract behaving correctly in the wild: the gate is
"best-effort, not fail-closed" — `judgeUiQuality` swallows every judge failure
(`docs/adr/0058-ui-quality-gate-in-browser-verification.md:55`) — so the outage
left `uiQuality` off the report and `approved` stayed exactly what functional
verification computed. A judge outage did not block a run that otherwise passed.

The practical cost is that the *scored* revision is rev 1, mid-build, rather
than the finished counter. Rev 1 is nonetheless a fully rendered app and
satisfies this ticket's outcome; re-scoring rev 2's screenshots after the limit
reset would be an isolated `evaluateUiQuality()` call, which is precisely the
#515-shaped evidence #509 and #527 exist to move past. (It would also not
inherit rev 1's `responsive-sanity` limitation — rev 2's plan uses a `375×667`
mobile viewport, where rev 1's is uniformly `1280×720`.)

## The blocking gate's baseline

**0.55 ≥ 0.3, so the gate passes.** With `minOverallScore: 0.3` configured,
`gateOnUiQuality` left `approved: true` untouched — confirmed in
`browser-verification-report-rev1.json`, whose `summary` carries no
"UI-quality gate failed" clause.

Two caveats on "the gate's configured threshold", both worth stating plainly:

- **No threshold ships on `main`.** `policies/default.yaml` sets no
  `uiQualityJudge` block at all, so by default the judge never runs and the gate
  never blocks (`packages/orchestrator/src/workflow-orchestrator.ts:2972`
  reads `policy.uiQualityJudge?.minOverallScore`, which is `undefined`). The
  `0.3` used here is the value #477's plan and tests use; it is not a shipped
  default. #516 promoted the judge to a gate that *can* block — it did not
  configure one that does.
- **The margin is thin.** A healthy, functional app scored 0.55 against a 0.3
  bar — passing, but only 0.25 above it, on a build whose UI is a plain
  scaffold. Two criteria (navigation 0.35, and the unscoreable responsive-sanity
  0.5) sit at or near the bar on their own. Anyone raising the threshold toward
  0.6 should expect to block working apps.

## Cost

All model calls were real (`EXECUTOR_MODE=real`). As in #509 the harness
recorded `totalEstimatedCostUsd: 0` for every entry — untracked in this config,
not actually free — so tokens and wall-clock are the honest signal.
Raw: [`models-metrics.json`](models-metrics.json).

| Model | Category | Attempts | Successes | Input tokens | Output tokens | Duration |
|---|---|---|---|---|---|---|
| claude-opus | planning | 2 | 2 | 4,154 | 36,273 | 8m21s |
| claude-opus | implementation/database | 7 | 5 | 5,234 | 94,178 | 38m39s |
| codex-default (gpt-5.6-luna) | verification/tests | 2 | 2 | 942,037 | 15,392 | 6m16s |
| codex-default (gpt-5.6-luna) | implementation/database | 2 | 2 | 6,248,284 | 31,116 | 13m53s |
| **total** | | | | **7,199,709** | **176,959** | |

The judge itself is not in that table: it bypasses the routed-agent pipeline
(ADR 0058), so nothing meters it. Two revisions exist and one carries a score,
which implies two judge invocations — but no metric or event records a judge
attempt, so treat that count as inferred rather than measured.

Wall-clock ~72 minutes (16:25Z → 17:37Z). One run, as the ticket required; no
second run was started.

## Why the run has no terminal status

The run reached T7 of 8 (`plan-task-browser-test.T7`) before the driving
process was stopped externally — same ending as #509, and again not a crash,
stall, or defect: events landed steadily throughout and `run.json` is still
`status: running`.

It was not, however, running *cleanly* by then. The rate limit above had failed
two `claude-opus` implementation attempts, `models-metrics.json` records
`consecutiveFailures: 2` on `claude-opus::v2::implementation/database`, and T7
had just been re-routed onto `codex-default`. The run was degraded but still
progressing when it stopped.

Everything this ticket asked for was already on disk by then. Per the ticket's
own cost guardrail, an external stop is not a fixable cause in the codebase, and
re-confirming it would cost another ~70 minutes of real API budget.

## Scope note

Evidence only. No production code changed: the `--approve-gates` driver landed
with #509 and #526's preview fixes landed with PR #534. Nothing here alters the
judge, the rubric, or the gate.
