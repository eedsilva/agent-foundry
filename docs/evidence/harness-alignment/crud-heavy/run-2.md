# crud-heavy — run 01KZM202P9RR02G7KCJYPZEMQK, project 01KZM202P998AY1WY1QE5DXZN3

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
  -d '{"name":"crud-heavy","workflowId":"web-app-v1","prd":"<contents of prd.md>"}'
```

**Terminal state:** `failed` (harness crash, not a scored accepted/exhausted outcome — same
failure class as run-1, see defect #1 in the ranked defect list).

**Preflight note:** the first preflight attempt this session failed at the `scaffold`
boundary (`environment-blocked`, exit 137 / OOM on the 3GiB scaffold sandbox cap —
`packages/executors/src/docker-preview-installer.ts:62`). Root cause was host contention:
~10 leftover Supabase stacks from unrelated prior sessions had the Docker Desktop VM
(7.75GiB total) nearly fully consumed with essentially no free memory. After operator-
approved cleanup of 9 confirmed-orphaned stacks (their originating workspace directories
no longer existed on disk; `397run17`, `nexus-pr185-review`, and `reviewgate` were left
untouched as plausibly-intentional or unrelated), preflight passed cleanly including both
model canaries. See defect #2 (environment/harness) in the ranked defect list.

**Timeline:**
- `20:04:02` project created, run queued.
- `20:07:38` plan-approval gate raised (`plan-approval`, request
  `01KZM26PNHPR285GFYRCFSRS3Z`), plan by `claude-haiku` — comprehensive CRUD plan matching
  the PRD (categories/items/stock-adjustments schema, RLS-scoped API, bulk-adjust
  endpoint, low-stock filter UI), with an explicit risk/decision log.
- `20:08:51` plan approved via the web UI. Unlike run-1, the approve/reject controls
  *were* discoverable this time, under the "Mudanças" (Changes) tab → "Aprovações" section
  → `approve`/`reject` buttons at the bottom of the plan card. Worth noting for defect #3
  (run-1's missing-control finding) — this run did not reproduce that specific symptom,
  though it's one data point, not a fix confirmation.
- `20:08:51` → `21:01:34` implementation running (Codex/`gpt-5.6-luna`), progressed through
  schema migrations (categories, items, stock_adjustments, RLS baseline), then failed at
  task T7's browser-verify step applying an RLS policy migration
  (`supabase/migrations/20260809000003_rls_categories_items_adjustments.sql`) that
  contains `drop policy if exists ...` statements ahead of `create policy` (a standard,
  idempotent policy-replacement pattern). The destructive-migration guard flagged this as
  destructive and raised `ValidationError: Destructive migration requires approval and
  verified backup.` with no operator-approval path — the run hard-failed instead of
  pausing for approval. `activeElapsedMs` at failure: 3,331,789 (~56 of the 60 min
  budget).
- `21:01:34` run status: `failed`.

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Categories + items CRUD, bulk quantity edit, stock-adjustment log, low-stock filter | Plan and schema migrations cover it; T1-T6 (schema, API routes) completed before the crash | `plan.current` artifact; migration files under workspace `supabase/migrations/` |
| Reach a running preview an operator can browser-verify | Never reached for T7 onward — the RLS-policy-replacement migration for T7 tripped the same destructive-migration guard as run-1's crash, this time on a `drop policy` statement rather than whatever tripped run-1 | step-run `01KZM59EHKVH1Y5DFE7NHHNDDJ`, attempt `01KZM59EJDT9K6JMWXNQV05Z69`, `err.name: "ValidationError"` |

No browser-acceptance or database-match evidence exists for this run — it never got that
far. Generated workspace retained at
`/tmp/agent-foundry-validation/projects/01KZM202P998AY1WY1QE5DXZN3/workspace` (note:
run-1's equivalent retained workspace was gone by the time this session started — `DATA_DIR`
evidence retention across sessions is not durable, see defect #2). Supabase stack for this
project (`supabase_01KZM202P998AY1WY1QE5DXZN3`) stopped and removed after this run per the
between-runs teardown procedure.

**Disposition:** two independent real-mode attempts at crud-heavy (run-1 in a prior
session, run-2 here) both crashed at the same destructive-migration guard with no
approval path, on different migrations. This is treated as sufficiently confirmed to stop
retrying this shape per the ticket's ground rules ("if a run stalls or errors in a way
this prompt doesn't cover, that stall is a defect — capture it and move to the next
shape"). Moving to dashboard-heavy (shape 2).
