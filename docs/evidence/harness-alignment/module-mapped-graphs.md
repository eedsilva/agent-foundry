# Module-mapped graph fixtures (#478, #479)

`app-shape.json` and `task-graph.json` in each of `crud-heavy/`, `dashboard-heavy/`,
and `auth-heavy/` are hand-authored, schema-validated fixtures — not captures from a
real planner LLM run. `app-shape.json` (#478) proves `AppShapeSchema` accepts a
realistic module list per HA-0.1 shape; `task-graph.json` (#479) proves
`GeneratedTaskGraphSchema` accepts a realistic 1:1 module-to-task-group mapping for
the same shape, and that the two files agree on the same module list.

A live real-mode LLM run per shape (the epic #470 exit evidence) needs cloud
campaign infrastructure and budget outside this repo's local implementation loop —
see `run-1.md` in each shape directory for the separate real-run evidence that
exists independently of these two files.
