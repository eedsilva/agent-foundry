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
curl -s -X POST http://localhost:4000/projects \
  -H 'content-type: application/json' \
  -d '{"name":"crud-heavy","workflowId":"web-app-v1","prd":"<contents of prd.md>"}'
```

**Terminal state:** `awaiting_approval` at the `plan-approval` gate. Deliberately
not approved further — #550's acceptance criteria only require planning to
complete with a module-mapped graph, not a full run to a terminal outcome; the
existing `run-1.md`/`run-2.md` in this directory already cover implementation/
verification behavior for this shape.

**Timeline:**
- `22:26:09` project created, run queued.
- `22:27:23` `plan` step attempt started (provider `claude`, model
  `claude-haiku-4-5-20251001`, routed via the `real-todo-v1` campaign).
- `22:29:00` `plan` step completed — 96.75s, $0.1142 (provider-reported),
  8,519 output tokens. `plan-approval` gate raised immediately after.

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
| Module-mapped task graph the real planner can produce for this shape | `plan.current` r1 carries `modules` (5 entries) and every task's `module`, schema-validated | plan artifact, this file's table above |

**Cost:** $0.1142 (one planning call only — this run does not proceed past the
plan-approval gate).
