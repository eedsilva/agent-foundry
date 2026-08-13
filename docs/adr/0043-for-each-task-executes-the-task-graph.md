# ADR 0043: `for-each-task` executes the plan's task graph, one commit per task

- Status: Accepted
- Date: 2026-07-27
- Owners: Core
- Builds on ADR 0039 (task-graph contract) and ADR 0042 (operator approves the plan)
- Superseded on the sequential-walk point by ADR 0064 (#520): "One git checkout means one task at
  a time; parallel tasks would need worktrees and are not in this change" (below) no longer holds
  — see ADR 0064 for the worktree-per-task design that replaces it. The rest of this ADR's
  decision stands.

## Context

`implementation-gate` handed a single `implement` node the job of building an entire application. It
either worked or it did not: a failure discarded the whole run, and pausing left nothing worth
keeping. Run `01KYCH4FJFZ5HDJTNX986B6P9Q` produced zero lines of application code across 13m21s and
$2.91; nothing in the engine read the `T1…T14` decomposition the planner had already written.

ADR 0039 gave `plan.current` a validated task graph — stable ids, dependency edges, deliverables and
an acceptance check per task. Nothing executed it. `quality-loop` cannot: its `setup`/`check`/`repair`
steps are fixed when the workflow is authored, and the task list only exists once the run has read the
artifact. Fanning out over a list discovered at runtime is a different node type, not a configuration
of the existing one.

## Decision

- A new `for-each-task` workflow node type in `packages/contracts`, executed by
  `packages/orchestrator`, with the frontier rule (`nextReadyTask`) as a pure function in
  `packages/domain`. It carries `taskGraphArtifact` (which artifact to walk) and one `implement`
  agent step, which must declare `mutatesWorkspace: true` — a task that cannot commit is not a task.
- The walk is sequential and dependency-ordered: the next task is the first, in declaration order,
  whose blockers have all completed. Declaration order is not execution order. One git checkout means
  one task at a time; parallel tasks would need worktrees and are not in this change.
- The implement step runs per task under the derived id `<implement>.<taskId>`, with the task's
  title, deliverables, acceptance check and blockers appended to the workflow's instructions. That
  gives each task its own `StepRun`, request folder, timeline entries and commit
  (`agent(developer): <taskId>: <title>`), which is what "one commit per task" means in practice.
- **`implement.maxAttempts` is honoured here and observable.** Each attempt is a `StepRun` with its
  own `iteration`, each failure emits `task.failed` carrying `attempt` and `maxAttempts`, and
  exhausting the bound fails the task with `Task <id> failed after N attempt(s)`. #211 records the
  engine advertising `maxAttempts`/`maxIterations` and ignoring them; this node does not repeat that.
  The bound counts **task attempts**, not model calls: one attempt still walks the router's fallback
  candidates, which is the vendor ladder #327 turns into a deliberate escalation.
- A failed attempt rolls back only to the checkpoint that attempt took, so every task committed
  before it survives. Failing the node stops the walk — dependants of a failed task never run — but
  the operator keeps N committed tasks instead of nothing.
- The implement step's input artifacts are resolved once, before the first task, and those exact
  revisions are pinned into every task — including the graph revision the walk itself read. A replay
  after a pause therefore computes the same idempotency keys, reuses the completed tasks, and
  resumes at the first task that has not completed; and a sibling write mid-walk cannot change a
  later task's inputs out from under it. A replayed task restarts at the attempt its records already
  reached, not at attempt 1 — otherwise a task that succeeded on its second attempt would be
  implemented and committed twice after a pause, and a pause would refund the bound.
- Timeline events `task.started`, `task.completed` and `task.failed` carry the task id, the derived
  step id, the attempt, and the commit. A 20-task graph is otherwise a black box.
- Model pins stay scoped to the id the workflow declares (`implement`); the engine applies the pin to
  every per-task run of it, and `isAgentStep` accepts both the declared and the derived form so a
  single task can still be retried with an override.

## Consequences

- `web-app-v1` runs `task-execution` (`for-each-task`) where `implementation-gate`'s `setup` used to
  be. The `review-code` / `repair-code` loop stays for now; #324 deletes it when deterministic
  per-task verification replaces it. It reviews the repository plus the **latest**
  `implementation.report` revision — the last task's — rather than one report for the whole build,
  which is another reason the LLM gate is on its way out. Its `inputArtifacts` list now names
  `implementation.report` first, because the quality loop attributes its verdict to the first input
  carrying a route decision.
- Per-task deterministic verification (#324) and the per-task browser assertion (#325) are
  deliberately absent: this change establishes the loop and the commit, and neither is stubbed.
- Pause/resume mid-graph works at the orchestrator seam. #319 (resume compares every artifact in the
  project, not only the resuming node's declared inputs) is **not** fixed here and is still open; a
  sibling service writing an unrelated artifact while a run is paused still wedges the resume. That
  fix becomes more load-bearing now that pauses leave useful state.
- `MockAgentExecutor` writes a per-step file, without which a second mutating step leaves an
  identical tree, git finds nothing to commit, and per-task commits silently disappear in every
  mock-driven test.
