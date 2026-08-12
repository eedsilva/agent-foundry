# Agent Foundry

Agent Foundry turns an approved plan into durable, verifiable software delivery while preserving the evidence needed to understand every execution outcome.

## Language

**Task Graph**:
A validated dependency graph whose tasks define deliverables, blockers, and an acceptance channel.
_Avoid_: Task list, implementation plan

**Task Graph Execution**:
The dependency-ordered progression of a Task Graph. A task completes only after its implementation and declared acceptance channel succeed; failure stops dependent tasks while preserving tasks already completed.
_Avoid_: Task loop, batch execution

**Schema Plan**:
A validated, operator-reviewable data-model artifact — tables, columns, constraints, indexes, and per-table RLS policies — that implementation tasks receive as input instead of inventing tables ad hoc. Reviewed and approved before implementation tasks execute.
_Avoid_: Data model doc, migration plan
