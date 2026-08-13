# Agent Foundry

Agent Foundry turns an approved plan into durable, verifiable software delivery while preserving the evidence needed to understand every execution outcome.

## Language

**Task Graph**:
A validated dependency graph whose tasks define deliverables, blockers, and an acceptance channel.
_Avoid_: Task list, implementation plan

**Task Graph Execution**:
The dependency-ordered progression of a Task Graph. A task completes only after its implementation and declared acceptance channel succeed; failure stops dependent tasks while preserving tasks already completed. Independent tasks may run concurrently, each isolated in its own git worktree identified by a path-segment-safe label rather than a host path.
_Avoid_: Task loop, batch execution

**Schema Plan**:
A validated, operator-reviewable data-model artifact — tables, columns, constraints, indexes, and per-table RLS policies — that implementation tasks receive as input instead of inventing tables ad hoc. Reviewed and approved before implementation tasks execute.
_Avoid_: Data model doc, migration plan

**Generated Migration**:
The forward-only SQL file (`supabase/migrations/<timestamp>_schema_plan.sql`) the orchestrator derives from an approved Schema Plan and writes into the project workspace. Implementation and repair tasks treat it as authoritative and add migrations of their own only for what the Schema Plan doesn't cover — never to redefine a table it already planned.
_Avoid_: Hand-written migration, schema migration
