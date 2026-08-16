# Plan — #571: a refused browser plan defers the task instead of killing the run

Spec: GitHub issue #571 (`eedsilva/agent-foundry`). Defect #2 in
`docs/evidence/harness-alignment/defect-list.md`. Blocks #564.

## Problem

`packages/orchestrator/src/task-graph-runner.ts` `assertTask()`: when a task
whose `acceptanceMode` is `browser-visible` gets a `status: "blocked"` answer
from its browser-plan step, the runner throws `ExecutionError` and the whole run
dies. The tester is answering correctly — the component is not yet on a
reachable route because the task that integrates it is sequenced later.

## Decision (the shape every task implements)

**Defer the refused browser acceptance to an end-of-graph re-assertion.**

- A refused plan on a `browser-visible` task records a deferral and lets the
  task complete. It is *not* an acceptance.
- After every task in the graph has run (both the sequential walk and the
  parallel pool), each deferral is asserted once more, in a fresh iteration
  band so nothing is reused from the refused first pass.
- A second refusal fails the run with a diagnosis naming the refusal summary and
  the `nextActions` it asked for.
- A deferral that is never re-asserted cannot happen: the end-of-graph pass is
  unconditional on the success path, and its only exits are approval or throw.

**Ruling (controller):** no defer-time "is a later task even capable of fixing
this?" lookahead. `nextActions` is free text; there is no reliable way to map it
onto a task id, and the end-of-graph re-assertion answers the same question
empirically. Cost if wrong: a refusal on the *last* task burns one extra
browser-plan agent call before the run fails.

**Ruling (controller):** the end-of-graph re-assertion must run in an iteration
band past the whole attempt ladder. `reuseCompletedStep` in
`workflow-orchestrator.ts` keys reuse on `(nodeId, stepId, iteration,
idempotencyKey)`; re-running the plan step at `iteration: 1` risks serving the
refused artifact straight back from cache, which would make deferral a no-op.
Cost if wrong: a few unused iteration numbers in the step-run table.

## Global Constraints

- Behaviour at the default path (`acceptanceMode` unset, or
  `deterministic-only`) must stay byte-identical — including event data.
- A `blocked` plan on a task that is *not* `browser-visible` keeps its current
  meaning ("no user-visible surface to assert") and still emits
  `quality.approved` with `asserted: false`. Do not touch that branch.
- No new dependency. No new file in `packages/orchestrator/src` — the change
  belongs in `task-graph-runner.ts`.
- `exactOptionalPropertyTypes` is on. Every task that touches `.ts` runs
  `npx tsc -b` as well as its tests.
- Repo checks: `npm run test:unit:fast` for the inner loop, plus
  `npx vitest run packages/orchestrator/src/task-graph-runner.test.ts`.

## Task 1 — defer a refused browser plan to an end-of-graph re-assertion

Files: `packages/contracts/src/project.ts`,
`packages/orchestrator/src/task-graph-runner.ts`,
`packages/orchestrator/src/task-graph-runner.test.ts`.

### 1a. New event kind

In `packages/contracts/src/project.ts`, add `'quality.deferred'` to the
`ProjectEventSchema` `type` enum, immediately after `'quality.repair_requested'`.
Nothing else in that file changes.

### 1b. The deferral record

In `task-graph-runner.ts`, above the `TaskGraphRunner` class, add:

```ts
/**
 * A browser acceptance whose plan step refused because the surface is not yet
 * reachable (#571). Held until every task in the graph has run, then asserted
 * once more; a second refusal fails the run (ADR 0070).
 */
interface DeferredAssertion {
  task: PlanTask;
  pinnedInputs: readonly ArtifactReference[];
  /** Per-task repair-streak key, carried so the re-assertion keeps the task's own counter. */
  scope?: string;
  /** The refusal's own words, replayed into the terminal diagnosis. */
  summary: string;
  nextActions: readonly string[];
}
```

### 1c. Iteration bands

Extract the stride expression that today lives inline in `executeTask`
(`const qualityAttemptStride = (browserAcceptance ? 2 : 1) * ((node.repair?.maxAttempts ?? 0) + 1);`)
into a module-level helper, and add the deferred band beside it:

```ts
function qualityAttemptStride(node: ForEachTaskStep, browserAcceptance: boolean): number {
  return (browserAcceptance ? 2 : 1) * ((node.repair?.maxAttempts ?? 0) + 1);
}

/**
 * The iteration band the end-of-graph re-assertion runs in (#571): past every
 * attempt's band, so its step runs never collide with — and are never reused
 * from — the refused first pass.
 */
function deferredIterationBase(node: ForEachTaskStep): number {
  return node.implement.maxAttempts * qualityAttemptStride(node, true);
}
```

`executeTask` keeps its local `const qualityAttemptStride = ...` value but sources
it from the helper (rename the local if it shadows). Its arithmetic is unchanged.

### 1d. `assertTask` gains a deferral sink

Signature becomes:

```ts
private async assertTask(
  input: TaskGraphRunInput,
  task: PlanTask,
  pinnedInputs: readonly ArtifactReference[],
  iterationBase = 0,
  /** Per-task repair-streak key (#520); absent at the default cap of 1. */
  scope?: string,
  /**
   * Sink for a refused plan (#571). Absent on the end-of-graph re-assertion,
   * where a refusal is terminal.
   */
  deferrals?: Map<string, DeferredAssertion>,
  planIteration = 1,
): Promise<StoredArtifact | null>
```

- The plan step's `executeStep` call uses `iteration: planIteration` instead of
  the literal `1`.
- Immediately before the plan step runs, `deferrals?.delete(task.id)` — each
  fresh assertion attempt resets this task's deferral state, so a retry that
  succeeds does not leave a stale deferral behind.
- In the `declared.data.status === 'blocked'` branch, replace the
  `browser-visible` throw with:
  - if `deferrals` is undefined → throw `ExecutionError`, message:
    `` `Task ${task.id} declares browser-visible acceptance, but its browser plan still refused after every task in the graph ran: ${summary}` `` plus, when
    `nextActions` is non-empty, `` ` (the refusal asked for: ${nextActions.join('; ')})` ``.
  - otherwise → `deferrals.set(task.id, {...})`, emit, and `return null`:

```ts
await this.emit(
  project.id,
  'quality.deferred',
  `${task.id}: browser acceptance deferred — ${declared.data.summary}`,
  {
    nodeId: node.id,
    runId,
    dedupeKey: `${runId}:task:${node.id}:${task.id}:browser:deferred`,
    data: {
      taskId: task.id,
      stepId: planStep.id,
      asserted: false,
      deferred: true,
      blockedReason: declared.data.summary,
      nextActions: declared.data.nextActions,
    },
  },
);
```

  The non-`browser-visible` branch below it keeps emitting `quality.approved`
  exactly as it does today.

### 1e. Wiring the two walks

`executeTask` takes a new trailing parameter
`deferrals?: Map<string, DeferredAssertion>` and forwards it to `assertTask` as
the 6th argument (leaving `planIteration` at its default).

Add:

```ts
/**
 * Re-asserts every browser acceptance a task deferred (#571), now that the
 * whole graph has run. No sink is passed, so a plan that refuses again throws.
 */
private async assertDeferred(
  input: TaskGraphRunInput,
  deferrals: Map<string, DeferredAssertion>,
): Promise<void> {
  const base = deferredIterationBase(input.node);
  for (const deferred of deferrals.values()) {
    const asserted = await this.assertTask(
      input,
      deferred.task,
      deferred.pinnedInputs,
      base,
      deferred.scope,
      undefined,
      base + 1,
    );
    if (asserted) {
      await this.verifyTask(
        input,
        deferred.task,
        asserted,
        deferred.pinnedInputs,
        base + (input.node.repair?.maxAttempts ?? 0) + 1,
        undefined,
        deferred.scope,
      );
    }
  }
}
```

- `runTraced`'s sequential walk: create
  `const deferrals = new Map<string, DeferredAssertion>();` before the loop, pass
  it into `executeTask`, and `await this.assertDeferred(input, deferrals);` after
  the `if (!latest) throw ...` guard, before `return latest`.
- `runPooled`: same map, threaded through `runPooledTask` into `executeTask`;
  call `assertDeferred` after `if (failure !== undefined) throw failure;` and
  after the two completeness guards, before `return latest`.

### 1f. Tests

Update the existing test `'fails a browser-visible task when its plan refuses the
assertion'` (`task-graph-runner.test.ts:751`) to the new behaviour: the run still
rejects, but on the new "still refused after every task in the graph ran" message,
and `task.completed` is now emitted once — the task completed, the *run* went red.
Rename it to say so.

Add, in the same describe block:

1. **Defers and then asserts.** Two tasks: `T1` browser-visible, `T2` plain
   depending on `T1`. The `plan-task-browser-test.T1` stub returns
   `blockedArtifact('T5Panel is not on a reachable route yet.')` with
   `nextActions: ['Run T2, which mounts the panel on /dashboard.']` on its first
   execution and a valid `browserPlan()` afterwards; `assert-task.*` returns
   `browserReport(true)`. Assert: the run resolves; one `quality.deferred` event
   carrying `nextActions`; two `task.completed`; `quality.approved` for the
   browser assertion.
2. **Never asserted stays red.** Same shape, but the plan stub refuses every
   time. Assert: the run rejects with a message containing both the refusal
   summary and the `nextActions` text; `task.completed` is 2 (tasks did complete);
   no `quality.approved` event with `asserted: true` for `T1`.
3. **The re-assertion runs in a fresh iteration band.** Record every
   `input.iteration` seen for `plan-task-browser-test.T1`; assert the two values
   are distinct and the second is `> node.implement.maxAttempts`. This is the
   guard against `reuseCompletedStep` serving the refused artifact back.
4. **Pooled path defers too.** With `maxParallelTasks` > 1 (mirror the existing
   pooled describe block's fixture), a browser-visible task whose plan refuses
   once still completes the run once the re-assertion approves.
5. Keep `'completes a task whose browser plan blocks assertion outside
   browser-visible acceptance (#537)'` green, untouched.

### 1g. Verification

- `npx vitest run packages/orchestrator/src/task-graph-runner.test.ts`
- `npx vitest run packages/contracts/src`
- `npx tsc -b` from the repo root
- `npm run test:unit:fast`

## Task 2 — ADR 0070 and the defect-list entry

Depends on Task 1 being committed; document what was actually built, not this plan.

- New `docs/adr/0070-deferred-browser-acceptance.md`, following the house format
  of `docs/adr/0069-*.md` (title line, `Status: Accepted`, `Date: 2026-08-16`,
  `Owners: Core`, `Tracked by issue #571`, `Builds on ADR 0045`, then Context /
  Decision / Consequences). It must answer the question #571 raises: **what does a
  task-level browser acceptance now assert?** Specifically that it is no longer
  "this task's surface was asserted before the next task started" but "this task's
  surface was asserted before the node completed"; that a deferral is never an
  acceptance; and that a deferral that never converts fails the run.
- Register it in `docs/adr/README.md` in the section its siblings use.
- Add a "Fixed by" / resolution note to defect #2's row (or the section beneath the
  table) in `docs/evidence/harness-alignment/defect-list.md`, pointing at #571 and
  ADR 0070. Do not rewrite the table's other rows.
- Verification: `npx prettier --check` on the files touched; `git diff --check`.
