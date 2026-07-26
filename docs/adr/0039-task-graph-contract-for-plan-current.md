# ADR 0039: plan.current carries a schema-validated task graph, opted in per step via outputContract

- Status: Accepted
- Date: 2026-07-26
- Owners: Core

## Context

The planner's decomposition was decorative. `web-app-v1` asks for "a dependency-aware task graph", the
planner harness suggests a `tasks` shape in prose, and nothing enforces or reads any of it — the plan's
`data` field is `JsonValueSchema`, so T1…T14 arrive as unvalidated prose and the executor ticket (#323)
has nothing machine-readable to walk. The one precedent for typing an artifact's payload is the browser
test plan: `AgentArtifactSchema.extend({ data: BrowserTestPlanSchema })`, validated with Zod at the
authoritative seam and mirrored to the provider as a `$id`'d JSON schema (ADR-recorded, `preview.ts`).

A complication: `plan.current` is written by two workflows. `web-app-v1` needs the task graph;
`dogfood-plan-v1` deliberately produces arbitrary analysis artifacts shaped by each dogfood PRD, and
hard-keying validation to the artifact *name* would break those runs.

## Decision

- `packages/contracts/src/plan.ts` defines `PlanTaskSchema` (id, title, dependsOn, deliverables,
  acceptanceCheck), `TaskGraphSchema` (a loose object so planner prose fields like `goal` and
  `milestones` pass through, with `tasks[]` strictly typed and referential integrity — unique ids,
  known dependencies, acyclic graph — enforced in `superRefine`), the `TaskGraphArtifactSchema`
  envelope, and a `TASK_GRAPH_ARTIFACT_JSON_SCHEMA` provider mirror with the runtime-validation
  extension marker, all following the browser-test-plan pattern.
- Agent steps opt in with a new optional workflow field `outputContract: task-graph`. The orchestrator
  then sends the task-graph JSON schema to the provider and hard-fails the attempt when the returned
  output does not parse — a non-conforming plan never becomes a `plan.current` revision; the normal
  retry/repair ladder handles it with the Zod issues attached.
- `web-app-v1`'s `plan` and `repair-plan` steps declare the contract; `dogfood-plan-v1` does not, on
  purpose.
- The project page renders any artifact whose content parses as a task-graph envelope as a readable
  task list (id, title, dependencies, deliverables, acceptance check), matching the existing
  shape-based rendering precedent (`isVerificationReport`).

## Consequences

- #323's `for-each-task` executor consumes `plan.current` data that is guaranteed to be a valid DAG.
- Each task's `acceptanceCheck` is the seed for the per-task browser assertion later in v0.10.5.
- A third typed artifact contract should unify the schema-selection sites (orchestrator ternary and
  mock-executor `$id` branch) into one `outputContract → schema` map; two sites are below the
  abstraction threshold today.
