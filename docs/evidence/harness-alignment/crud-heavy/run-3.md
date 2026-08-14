# crud-heavy — run 01M0163XDJGXY0RHMY8YXF28BR, project 01M0163XDHQVPPVKJB85BW0D0M

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
PRD_JSON="$(jq -Rs . docs/evidence/harness-alignment/crud-heavy/prd.md)"
curl -s -X POST http://localhost:4000/projects \
  -H 'content-type: application/json' \
  -d "{\"name\":\"crud-heavy\",\"workflowId\":\"web-app-v1\",\"prd\":${PRD_JSON}}"
```

**Terminal state:** `awaiting_approval` at the `plan-approval` gate. Deliberately
not approved further — #550's acceptance criteria only require planning to
complete with a module-mapped graph, not a full run to a terminal outcome; the
existing `run-1.md`/`run-2.md` in this directory already cover implementation/
verification behavior for this shape.

**Timeline:**
- `2026-08-14T22:26:09.457Z` project record created (`project.json`).
- `2026-08-14T22:27:23.108Z` `project.started` for run
  `01M0163XDJGXY0RHMY8YXF28BR` (event `01M01665B46T07RASVEVBNQZSA`).
- `2026-08-14T22:27:23.475Z` `plan` attempt started (event
  `01M01665PKYZ7C1R8R1N4CG9M7`, step run
  `01M01665CZ8PSCHK8Q65BX78G4`, attempt
  `01M01665MPG30J2X6V0BYRF61H`). Provider `claude`, model
  `claude-haiku-4-5-20251001`, routed via `real-todo-v1`.
- `2026-08-14T22:29:00.716Z` `plan.current` revision 1 created (event
  `01M01694NCCGKVZJDRDEWJ5RFP`; artifact SHA-256
  `4ed81a528678a58120fa3d139d4130bfe8153f9f5079b81e41c6f7347219f3ef`).
  The plan attempt completed in 96.75s for $0.1142 with 8,519 output tokens
  (provider-reported).
- `2026-08-14T22:29:00.869Z` `run.approval_requested` raised at
  `plan-approval` (event `01M01694T54V6VK6CNN76G5PDS`).

**Validation provenance (scrubbed, retained):**

The committed module/task table above is the scrubbed excerpt of the real
artifact. The following command was run from the repository root against the
retained disposable artifact and imports the production contracts package; a
successful parse executes the schema's module/task referential checks:

```sh
npx tsx -e 'import { readFileSync } from "node:fs"; import { GeneratedTaskGraphArtifactSchema } from "@agent-foundry/contracts"; const file = process.argv[1]; const result = GeneratedTaskGraphArtifactSchema.safeParse(JSON.parse(readFileSync(file, "utf8")).content); if (!result.success) { console.error(result.error.issues); process.exit(1); } console.log("PASS", file, "schemaVersion=" + result.data.schemaVersion, "status=" + result.data.status, "approved=" + result.data.approved, "modules=" + result.data.data.modules.length, "tasks=" + result.data.data.tasks.length);' \
  /tmp/agent-foundry-validation/projects/01M0163XDHQVPPVKJB85BW0D0M/artifacts/plan.current/000001.json
```

Result: `PASS ... schemaVersion=1 status=completed approved=false modules=5
tasks=9`. The artifact is intentionally not committed because the real-mode
data directory also contains disposable environment/workspace material; the
artifact event ID, SHA-256, run/step/attempt IDs, and scrubbed excerpt above
preserve the audit trail without committing generated data.

**Module-mapped plan (`plan.current`, validated against
`GeneratedTaskGraphArtifactSchema` — `npx tsx` + the real schema, not eyeballed):**

| Module | Acceptance channel | Tasks |
|---|---|---|
| `auth` | browser-visible | T1, T2, T3 |
| `crud:category` | browser-visible | T4 |
| `crud:item` | browser-visible | T5, T8 |
| `crud:stock-adjustment` | browser-visible | T6, T9 |
| `dashboard` | browser-visible | T7 |

All 5 declared modules are referenced by at least one task; every task's
`module` names a declared module — the 1:1 mapping `validateModuleTaskMapping`
enforces holds. (The planner named modules `crud:category`/`crud:item`/
`crud:stock-adjustment`, singular — the hand-authored `task-graph.json` fixture
in this directory uses the plural form; both are valid under the
`crud:<resource>` regex, and this run is evidence the planner's own vocabulary
choice differs slightly from the fixture's, not a defect.) The planner also
added a `dashboard` module (a low-stock overview) beyond the fixture's 4
modules — a genuine, unprompted design choice, not something this run's
harness config requested.

| Intent (from PRD) | Implemented boundary | Evidence |
|---|---|---|
| Module-mapped task graph the real planner can produce for this shape | `plan.current` r1 carries `modules` (5 entries) and every task's `module`, schema-validated | artifact event `01M01694NCCGKVZJDRDEWJ5RFP`, validator transcript above, scrubbed table |

**Cost:** $0.1142 (one planning call only — this run does not proceed past the
plan-approval gate).
