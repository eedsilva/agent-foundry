# auth-heavy — run 01M016AFGYQTE42NRVM2MCKAAS, project 01M016AFGXZ26Q1WJ1M71ECBM7

**Purpose (#550, HA-B.3):** first real-mode planning run against the module-mapped
task graph contract (#478, #479). Proves the real planner (Claude Haiku via the
`real-todo-v1` campaign route) actually emits `plan.current`'s `modules` list and
tags every task with its owning `module`, and that the result validates against
`GeneratedTaskGraphArtifactSchema`'s 1:1 module-to-task-group mapping — not just
the hand-authored fixtures `task-graph.json` (also #479) already proved the
schema *accepts*.

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
PRD_JSON="$(jq -Rs . docs/evidence/harness-alignment/auth-heavy/prd.md)"
curl -s -X POST http://localhost:4000/projects \
  -H 'content-type: application/json' \
  -d "{\"name\":\"auth-heavy\",\"workflowId\":\"web-app-v1\",\"prd\":${PRD_JSON}}"
```

**Terminal state:** `awaiting_approval` at the `plan-approval` gate. Deliberately
not approved further — #550's acceptance criteria only require planning to
complete with a module-mapped graph, not a full run to a terminal outcome; the
existing `run-1.md` in this directory already covers implementation/
verification behavior for this shape.

**Timeline:**
- `2026-08-14T22:29:44.605Z` project record created (`project.json`).
- `2026-08-14T22:36:13.199Z` `project.started` for run
  `01M016AFGYQTE42NRVM2MCKAAS` (event `01M016PB0FQ7ZJXM51N9NKXY11`).
- `2026-08-14T22:36:13.523Z` `plan` attempt started (event
  `01M016PBAKYET0266EWSESDAWZ`, step run
  `01M016PB1YMDZPAH4X4DRWKFV0`, attempt
  `01M016PB99KXW4X2R6ACJSDTJK`). Provider `claude`, model
  `claude-haiku-4-5-20251001`, routed via `real-todo-v1`.
- `2026-08-14T22:39:43.012Z` `plan.current` revision 1 created (event
  `01M016WQX4V0HAYK4PWES9WB5J`; artifact SHA-256
  `50b6fe54f046259d123c62d4260c51eb63ef0606df617f255f804d48284fca31`).
  The plan attempt completed in 208.87s for $0.1602 (provider-reported).
- `2026-08-14T22:39:43.158Z` `run.approval_requested` raised at
  `plan-approval` (event `01M016WR1P3KJMSPJY0ERJP0DH`).

**Validation provenance (scrubbed, retained):**

The committed module/task table above is the scrubbed excerpt of the real
artifact. The following command was run from the repository root against the
retained disposable artifact and imports the production contracts package; a
successful parse executes the schema's module/task referential checks:

```sh
npx tsx -e 'import { readFileSync } from "node:fs"; import { GeneratedTaskGraphArtifactSchema } from "@agent-foundry/contracts"; const file = process.argv[1]; const result = GeneratedTaskGraphArtifactSchema.safeParse(JSON.parse(readFileSync(file, "utf8")).content); if (!result.success) { console.error(result.error.issues); process.exit(1); } console.log("PASS", file, "schemaVersion=" + result.data.schemaVersion, "status=" + result.data.status, "approved=" + result.data.approved, "modules=" + result.data.data.modules.length, "tasks=" + result.data.data.tasks.length);' \
  /tmp/agent-foundry-validation/projects/01M016AFGXZ26Q1WJ1M71ECBM7/artifacts/plan.current/000001.json
```

Result: `PASS ... schemaVersion=1 status=completed approved=false modules=3
tasks=8`. The artifact is intentionally not committed because the real-mode
data directory also contains disposable environment/workspace material; the
artifact event ID, SHA-256, run/step/attempt IDs, and scrubbed excerpt above
preserve the audit trail without committing generated data.

**Module-mapped plan (`plan.current`, validated against
`GeneratedTaskGraphArtifactSchema` — `npx tsx` + the real schema, not eyeballed):**

| Module | Acceptance channel | Tasks |
|---|---|---|
| `auth` | browser-visible | T2, T5, T8 |
| `crud:profile` | browser-visible | T1, T3, T4 |
| `dashboard` | browser-visible | T6, T7 |

All 3 declared modules are referenced by at least one task; every task's
`module` names a declared module — the 1:1 mapping `validateModuleTaskMapping`
enforces holds. (The planner named the module `crud:profile`, singular — the
hand-authored `task-graph.json` fixture in this directory uses `crud:profiles`;
both are valid under the `crud:<resource>` regex, and this run is evidence of
the planner's own vocabulary choice, not a defect.) The planner also added a
`dashboard` module (an admin member-overview surface) beyond the fixture's 2
modules — a genuine, unprompted design choice, not something this run's harness
config requested.

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Module-mapped task graph the real planner can produce for this shape | `plan.current` r1 carries `modules` (3 entries) and every task's `module`, schema-validated | artifact event `01M016WQX4V0HAYK4PWES9WB5J`, validator transcript above, scrubbed table |

**Cost:** $0.1602 (one planning call only — this run does not proceed past the
plan-approval gate).
