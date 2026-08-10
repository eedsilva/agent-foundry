# auth-heavy — run 01KZM7ZTQX1E4ABB5KM2HFVXM1, project 01KZM7ZTQXCZW8GB9BRRMYFZ6P

**Command:**
```
DATA_DIR=/tmp/agent-foundry-validation \
VALIDATION_CAMPAIGN=real-todo-v1 \
CODEX_DEFAULT_MODEL=gpt-5.6-luna \
CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
EXECUTOR_MODE=real \
npm run dev
```
```
curl -s -X POST http://localhost:4000/validation/campaign/preflight
curl -s -X POST http://localhost:4000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"auth-heavy","workflowId":"web-app-v1","prd":"<contents of prd.md>"}'
```

**Terminal state:** `exhausted` — active-time budget (60 min) reached cleanly, no crash.
API reports this as `run.status: "failed"` with
`error.code: "VALIDATION_CAMPAIGN_LIMIT"`; the auto-published evidence bundle classifies
the outcome as `product-failed` (there is no distinct `exhausted` value in the bundle's
outcome taxonomy — see defect #6, a terminology gap between the ticket's language and the
harness's actual classification vocabulary). Preflight passed cleanly (all 11 boundaries,
both canaries) on the first attempt.

**Timeline:**
- `21:48:45` project created, run queued.
- `21:51:49` plan-approval gate raised — plan by `claude-haiku`, 15 tasks (T1-T15)
  covering the profiles/RLS schema, auth, route-protection middleware, own-profile page,
  admin member directory + detail + role management, admin-bootstrap seed, cross-tenant
  denial tests, and end-to-end workflows.
- `21:52:16` plan approved via the web UI ("Mudanças" → "Aprovações" → `approve`).
- `21:52:17` → `22:50:02` implementation running (Codex/`gpt-5.6-luna` for
  implementation/repair, `claude-haiku` for verification). Completed, in order: T1
  (profiles table + RLS), T2 (auth) with passing browser assertion, T3 (route protection
  middleware) with passing browser assertion, T4 (profile API routes), T5 (own-profile
  view/edit) with passing browser assertion, T6 (admin member directory page) —
  implementation and internal verify completed, but the run hit the 60-minute active-time
  ceiling while T6's browser-test plan was being generated. `activeElapsedMs` at
  termination: 3,600,725 (exactly the 60 min cap).
- `22:50:02` run status: `failed` / `VALIDATION_CAMPAIGN_LIMIT` (exhausted).

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Auth, own profile, RLS-enforced profiles table | Complete and browser-verified (T1-T5, assertions passed) | `assert-task.T2`/`T3`/`T5` step-runs, all `status: "completed"`, `error: null` |
| Admin member directory, member detail + role change, admin-only route gating, admin bootstrap seed | Not reached — T6 (directory page) implemented but unverified when the budget ceiling hit; T7-T15 never started | plan artifact task list; step timeline stops at `plan-task-browser-test.T6` |
| RLS enforced at the database layer, not just hidden in the UI | Table + policies created in T1; no direct-query denial test was reached (that's T11/T12, unstarted) | `supabase/migrations/` in the retained workspace |

Six of 15 planned tasks completed (40%), three with passing browser-level acceptance —
the furthest any of the three shapes progressed this session. This is the strongest
evidence that a 15-task PRD sized for "auth-heavy" plausibly needs more than the
campaign's 60-minute active-time budget to reach a real terminal (accepted/failed-on-
merits) state — see defect #7 (budget/PRD-sizing calibration).

Generated workspace retained at
`/tmp/agent-foundry-validation/projects/01KZM7ZTQXCZW8GB9BRRMYFZ6P/workspace`. Supabase
stack (`supabase_01KZM7ZTQXCZW8GB9BRRMYFZ6P`) stopped and removed after this run per the
between-runs teardown procedure.

**Disposition:** exhausted is itself a Track 0 finding per the ticket, not a run failure.
No retry attempted — this satisfies the ticket's "reach a terminal state" requirement for
this shape.
