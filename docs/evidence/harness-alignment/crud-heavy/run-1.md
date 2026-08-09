# crud-heavy — run 01KZJAGWEF6KF9540K5F35HENN, project 01KZJAGWEFT0BPSAJBFFQ93RZG

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

**Terminal state:** `failed` (harness crash, not a scored accepted/exhausted outcome — see
defect #4 in the ranked defect list).

**Timeline:**
- `03:54:32` project created, run queued.
- `03:59:07` plan-approval gate raised (`plan-approval`, request
  `01KZJAS8THJRSH0PDQRVCVMF5Z`), plan by `claude-haiku` — a CRUD-heavy inventory plan
  matching the PRD (categories/items/stock-adjustments schema, RLS-scoped API routes,
  bulk-adjust endpoint, web UI with low-stock filter).
- `04:01:44` plan approved (`POST /runs/:runId/approvals/:requestId/decide`, operator
  identity `operator (tracer #473)` — done via API after the web UI at
  `localhost:3000?tab={atividade,execucao,mudancas,artefatos}` showed no discoverable
  approve/reject control for the gate; see defect #3).
- `04:01:44` → `04:46:26` implementation running (Codex/`gpt-5.6-luna`), reached the
  browser-verify step, which crashed applying a destructive migration with no approval
  path (defect #4). `activeElapsedMs` at failure: 2,873,397 (~48 of the 60 min budget).
- `04:46:26` run status: `failed`.

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Categories + items CRUD, bulk quantity edit, stock-adjustment log, low-stock filter | Plan covers all of it (see plan.current r1, tasks T1-T6+) | plan artifact, `GET /runs/:id` timeline |
| Reach a running preview an operator can browser-verify | Never reached — implementation's own DB-sync step crashed before preview/browser verification ran | job log `err.type: "ValidationError"`, stack in defect notes |

No browser-acceptance or database-match evidence exists for this run — it never got that
far. Generated workspace retained at
`/tmp/agent-foundry-validation/projects/01KZJAGWEFT0BPSAJBFFQ93RZG/workspace` for anyone
who wants to inspect the migration that tripped the destructive-migration guard.
