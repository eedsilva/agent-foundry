# dashboard-heavy — run 01KZM5NBM46QFJBAFTZHJP5PWJ, project 01KZM5NBM4K5T96ATG2XA5XJP9

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
  -d '{"name":"dashboard-heavy","workflowId":"web-app-v1","prd":"<contents of prd.md>"}'
```

**Terminal state:** `failed` (harness crash, not a scored accepted/exhausted outcome — see
defect #5 in the ranked defect list). Preflight for this run passed cleanly (all 11
boundaries, both canaries) on the first attempt — the leftover-stack cleanup done before
run 1 held for this run too.

**Timeline:**
- `21:08:04` project created, run queued.
- `21:11:40` plan-approval gate raised, plan by `claude-haiku` — covers the seeded
  90-day sales dataset, date-range filter, revenue/unit trend, top-5 breakdown, manual
  entry, event list.
- `21:12:11` plan approved via the web UI ("Mudanças" → "Aprovações" → `approve`).
- `21:12:11` → `21:41:35` implementation running (Codex/`gpt-5.6-luna`); T1-T4 completed
  (schema, seed data, API routes). Task T5 (`DateRangePicker` component) implemented, then
  its browser-test-plan step (`plan-task-browser-test.T5`, tester `claude-haiku`) **refused
  to write assertions**: the component exists at
  `apps/web/app/components/DateRangePicker.tsx` with full functionality (30-day default,
  date inputs, onChange, validation) but the plan sequenced T5 before T10 (the task that
  wires it into the dashboard route), so it has no reachable URL to browser-test against.
  The tester's `browser-test.plan` artifact is well-reasoned and explicit:
  `status: "blocked"`, `approved: false`, with `nextActions: ["Complete task T10 to
  integrate DateRangePicker into dashboard page", "Regenerate browser test plan once
  component is accessible via dashboard route"]`.
- Rather than deferring T5's verification or re-sequencing toward T10, the orchestrator
  surfaced the tester's blocked/refused plan as a hard run failure:
  `ExecutionError: "Task T5 declares browser-visible acceptance, but its browser plan
  refused the assertion"`. `activeElapsedMs` at failure: 1,932,009 (~32 of the 60 min
  budget).
- `21:41:35` run status: `failed`.

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Seeded dataset, totals, trend chart, top-N breakdown, date-range filter, manual entry | T1-T4 completed (schema, seed, API routes); T5's component built correctly but the *plan's own task ordering* put verification before integration | plan artifact; `apps/web/app/components/DateRangePicker.tsx` in workspace |
| Reach a running preview an operator can browser-verify | Never reached — the tester correctly identified the component was unreachable and refused to fabricate a passing assertion, but the harness has no path to act on a "blocked, re-plan after T10" verdict other than failing the whole run | `browser-test.plan` artifact `01KZM7G2J40D2EAQMNBJJ551GT` (`status: "blocked"`), run-level `ExecutionError` |

No browser-acceptance or database-match evidence exists for this run — it never got that
far. Generated workspace retained at
`/tmp/agent-foundry-validation/projects/01KZM5NBM4K5T96ATG2XA5XJP9/workspace`. Supabase
stack (`supabase_01KZM5NBM4K5T96ATG2XA5XJP9`) stopped and removed after this run per the
between-runs teardown procedure.

**Disposition:** this is a distinct, well-evidenced failure mode from crud-heavy's
destructive-migration crash (task-sequencing produced an unreachable component, and the
tester's honest "blocked" verdict has no repair/re-plan path — it just crashes the run).
One real attempt is sufficient evidence here; not retrying, per the ticket's ground rule
to capture and move to the next shape rather than debug live. Moving to auth-heavy
(shape 3).
