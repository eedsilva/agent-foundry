# Ranked defect list — #473 real-mode tracer, 3 app shapes

Source runs: [`crud-heavy/run-1.md`](crud-heavy/run-1.md) (prior session, failed),
[`crud-heavy/run-2.md`](crud-heavy/run-2.md) (failed), [`dashboard-heavy/run-1.md`](dashboard-heavy/run-1.md)
(failed), [`auth-heavy/run-1.md`](auth-heavy/run-1.md) (exhausted). All real mode,
`real-todo-v1` campaign, models pinned to `claude-haiku-4-5-20251001` / `gpt-5.6-luna`.

| # | Defect | Shape(s) | Track | Class | Severity | Evidence |
|---|---|---|---|---|---|---|
| 1 | Destructive-migration guard (`destructiveStatements` in `packages/platform/src/supabase-runtime.ts:1178-1188`) matches any statement starting with `DROP` — including idempotent `DROP POLICY IF EXISTS`, a routine RLS-replacement pattern — and the `.migrate()` approval path (`input.approval?: MigrationApproval`, same file, line 403) exists at the platform layer but is never wired into the real-mode workflow's step/gate system. When a browser-verify step triggers a migration with any `DROP` statement, the run hard-crashes with an unrecoverable `ValidationError` instead of raising an operator-approval gate. Reproduced twice independently, on two different migrations. | crud-heavy | D (orchestration) | product-failed | high — blocks any shape whose schema needs a policy replacement or column drop during iterative development, and the run cannot recover once it happens | `crud-heavy/run-1.md`, `crud-heavy/run-2.md`; step-run `01KZM59EHKVH1Y5DFE7NHHNDDJ`; guard source at `packages/platform/src/supabase-runtime.ts:1178-1188,410-417` |
| 2 | When a planned task's browser-visible acceptance is sequenced before the task that integrates the component into a reachable route, the tester correctly refuses to fabricate a passing assertion (`browser-test.plan` artifact: `status: "blocked"`, explicit `nextActions` pointing at the missing integration task) — but the orchestrator has no path to defer/re-sequence on that verdict. It surfaces the refusal as a hard `ExecutionError` and fails the entire run. | dashboard-heavy | D (orchestration) | product-failed | high — the tester did its job correctly; the harness discards that signal instead of acting on it | `dashboard-heavy/run-1.md`; `browser-test.plan` artifact `01KZM7G2J40D2EAQMNBJJ551GT`; run error `ExecutionError: "Task T5 declares browser-visible acceptance, but its browser plan refused the assertion"` |
| 3 | Campaign preflight's scaffold sandbox (hard-capped at 3GiB, `packages/executors/src/docker-preview-installer.ts:62`) OOM-kills (exit 137) under host memory contention when the Docker Desktop VM (7.75GiB total) is already crowded by leaked Supabase stacks from unrelated prior sessions. This blocked preflight — and therefore all 3 shapes — until 9 orphaned stacks (dated 2026-07-28 through 2026-08-09, confirmed via container inspection that their originating workspace directories no longer existed on disk) were manually identified and removed with operator sign-off. There is no automatic reclamation of stacks whose backing project directory is gone. | all 3 (blocked preflight universally, not shape-specific) | harness | environment-blocked | high — silently blocks every real-mode run on a host with any accumulated leak history, with no diagnostic pointing at the actual cause (the preflight error just says "Scaffold preview did not start") | preflight reports at `20260809T19:32` and `19:35` (`status: "environment-blocked"`, `errorCode: "PREFLIGHT_FAILED"`); `docker network inspect` timestamps/labels showing 9 stacks with no matching `DATA_DIR` project directory; known prior art — memory note "Docker address pool exhaustion", issue #292 |
| 4 | The campaign's 60-minute active-time budget was insufficient for a 15-task auth-heavy PRD: 6/15 tasks completed (40%), all 3 browser-verified tasks reached so far passed cleanly — quality wasn't the limiter, wall-clock was. The run terminated via `ValidationCampaignLimitError` mid-task rather than at a task boundary. | auth-heavy | D / harness (budget calibration) | product-failed (see also #6) | medium — not a bug, but a sizing mismatch between the PRD complexity this ticket asked for ("sized to plausibly finish inside the 60-minute budget") and what real 2-role/RLS/route-matrix PRDs actually need | `auth-heavy/run-1.md`; task timeline showing T1-T6 complete, T7-T15 unstarted; `activeElapsedMs: 3,600,725` (exactly the cap) |
| 5 | `DATA_DIR` evidence retention is not durable across sessions. `crud-heavy/run-1.md` (prior session) stated the generated workspace was "retained... for anyone who wants to inspect the migration" at a path under `/tmp/agent-foundry-validation/projects/`. By the time this session started (same `DATA_DIR`, ~15h later), that directory no longer existed — `/tmp/agent-foundry-validation/projects/` was empty. The evidence-retention promise in run documentation doesn't hold against normal `/tmp` lifecycle. | crud-heavy | harness | environment-blocked | medium — undermines any evidence doc that says "retained for inspection" when `DATA_DIR` lives under `/tmp` per the documented operator convention | this session's `ls /tmp/agent-foundry-validation/projects/` returning empty vs. `crud-heavy/run-1.md`'s retention claim |
| 6 | The validation-evidence bundle's `outcome` field has no distinct value for a budget-exhausted run — the auth-heavy run's bundle reports `outcome: "product-failed"`, identical to what a genuine implementation defect would produce, with the actual reason recoverable only via `terminalState.error.code: "VALIDATION_CAMPAIGN_LIMIT"`. This ticket's own language ("an exhausted run is itself a Track 0 finding, not a failure") has no corresponding first-class status in the harness's own taxonomy. | auth-heavy | harness | environment-blocked | low — cosmetic/reporting gap, doesn't affect run behavior, but makes exhausted vs. genuinely-broken runs indistinguishable from the bundle's top-level fields alone | `GET /runs/:runId/validation-evidence` bundle for `01KZM7ZTQX1E4ABB5KM2HFVXM1`: `terminalState.error.code = "VALIDATION_CAMPAIGN_LIMIT"`, `outcome = "product-failed"` |
| 7 | Preview panel showed `{"error":"PreviewAccessDeniedError","message":"Preview session ... "}` immediately after the crud-heavy plan-approval gate was raised, while the preview was reported as `running` in the same screenshot. Observed once, not investigated further (out of scope to debug live per this ticket's ground rules). | crud-heavy | A (UI) | product-failed | low — cosmetic mismatch between preview status badge and panel content; did not block the run | screenshot at crud-heavy run 2, `21:07:38` gate-raised state |
| 8 | `crud-heavy/run-1.md` (prior session) reported the plan-approval gate had no discoverable approve/reject control anywhere in the web UI, forcing an API-only approval workaround. Not reproduced in any of this session's 3 attempts — the control was consistently found under "Mudanças" → "Aprovações" → `approve`/`reject` buttons at the bottom of the plan card. Recorded as unconfirmed, not as a fix verification (one prior negative vs. three later positives is not a controlled test). | crud-heavy (prior session only) | A (UI) | product-failed | low / unconfirmed | `crud-heavy/run-1.md:29-31`; this session's 3 successful UI-driven approvals, e.g. `crud-heavy/run-2.md` |

## Boundaries of this validation

- **Three runs, one operator session.** All three shapes ran sequentially in a single
  sitting on 2026-08-09 (plus one prior crud-heavy attempt from 2026-08-09 early morning,
  a separate session). This is not a statistically powered sample — each shape got 1-2 real
  attempts, not enough to distinguish a systemic defect from an unlucky roll, except where
  explicitly reproduced (defect #1, 2x).
- **Pinned models only.** Every run used `claude-haiku-4-5-20251001` for planning/
  verification and `gpt-5.6-luna` for implementation/repair — the campaign's cloud-only,
  fast/economy tier. None of this evidence says anything about how a deeper model
  (Sonnet/Opus, or a local executor per #415) would fare against the same PRDs or defects.
- **60-minute active-time budget per run.** Two of three shapes (crud-heavy, dashboard-
  heavy) crashed on harness-level defects well before exhausting budget; only auth-heavy
  ran the clock out, and only got 40% through its plan. No shape reached the browser-
  acceptance + database-match stage this session, so **no evidence exists here about
  `validation-acceptance`/`validation-evidence` publishing correctness for a genuinely
  accepted run**, RLS enforcement at the database layer for auth-heavy specifically (T11/
  T12 never ran), or dashboard-heavy/crud-heavy's UI polish, since none of them reached a
  running, browser-verifiable preview.
- **Host state at session start was not clean.** This session inherited ~10 leaked
  Supabase stacks from unrelated prior work (defect #3) and had to clean 9 of them before
  any run could proceed. The preflight failures this caused are host-contention artifacts
  of accumulated prior sessions, not necessarily reproducible on a freshly provisioned
  host — though the underlying lack of automatic reclamation (nothing stops leaked stacks
  from accumulating) is real regardless.
- **No defects were fixed, no follow-up tickets were filed, no benchmarking was done, and
  no fourth shape was run**, per this ticket's explicit scope.

## Post-validation fixes

- **Defect #2 — fixed by #571.** A refused browser plan now defers to an
  end-of-graph re-assertion instead of failing the run outright; only a
  refusal that still stands once every task has run is terminal. See
  [ADR 0070](../../adr/0070-deferred-browser-acceptance.md).
