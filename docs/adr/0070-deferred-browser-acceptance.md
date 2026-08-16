# ADR 0070: A refused browser acceptance defers to end-of-graph, it does not kill the run

- Status: Accepted
- Date: 2026-08-16
- Owners: Core
- Tracked by issue #571
- Builds on ADR 0045 (per-task deterministic verification)

## Context

Defect #2 in `docs/evidence/harness-alignment/defect-list.md` reproduced a
concrete failure of task sequencing: when a plan puts a browser-visible task's
acceptance before the task that wires its component into a reachable route,
the browser-test agent does exactly what it should — it refuses to fabricate
a passing assertion. Its `browser-test.plan` artifact comes back
`status: "blocked"`, with a `summary` explaining what is unreachable and a
`nextActions` list naming what would have to change. `TaskGraphRunner.assertTask`
treated that refusal as fatal: it threw an `ExecutionError` and the whole run
died on a correct verdict.

The tester was right. The harness had no path to act on the verdict except to
discard it and fail the graph.

## Decision

**A blocked browser plan is deferred, not fatal, the first time it happens.**
`executeTask`'s `browserAcceptance` branch now passes a `deferrals: Map<string,
DeferredAssertion>` sink into `assertTask`. When the plan step's parsed
`AgentArtifactSchema` comes back `status: 'blocked'` and a sink is present,
`assertTask` records a `DeferredAssertion` (the task, its pinned inputs, its
repair-streak `scope`, and the refusal's own `summary`/`nextActions`), emits a
`quality.deferred` event, and returns `null` instead of throwing. The task's
attempt loop in `executeTask` proceeds exactly as if there were no browser
acceptance for this attempt: `reverified` is `null`, the loop commits
`repaired ?? implementation`, and `task.completed` still fires.

**What "the task's acceptance was asserted" now means is weaker than it was.**
Before this change, a browser-visible task completing meant its user-visible
surface had already been asserted in a real browser — the assertion happened
before the *next* task in the graph could start. After this change it means
the surface will be asserted before the *node* completes, not before this
task's neighbors run. `task.completed` can now be emitted for a task whose
browser acceptance has not happened yet; the `quality.deferred` event on that
task's id is the only record that the completion is provisional.

**A deferral is not an acceptance, and one that never converts fails the run.**
Both graph walks (`runTraced`'s single-threaded loop and `runPooled`'s
concurrent one) collect deferrals into the same map and, once every task in
the graph has completed, call a new private method, `assertDeferred`. It
re-runs `assertTask` for each deferred task with no `deferrals` argument. That
absence is the whole mechanism: `assertTask`'s blocked branch only defers when
a sink is passed, so the re-assertion's refusal branch falls through to the
same `ExecutionError` throw the original defect reported, now carrying the
refusal's `summary` and `nextActions` in the message. A deferral that never
gets a reachable route still fails the run — it just fails at the end of the
graph, with the whole graph's context available, instead of at the moment the
tester first noticed the gap.

**The re-assertion runs in its own iteration band, not `iteration: 1`.**
`assertTask` grew a `planIteration` parameter (default `1`, preserving every
existing call site's behavior) that becomes the plan step's `executeStep`
`iteration`. `assertDeferred` computes `deferredIterationBase(node)` —
`node.implement.maxAttempts * qualityAttemptStride(node, true)`, i.e. past
every band any real attempt could reach — and calls `assertTask` with
`planIteration: base + 1`. This is not decoration: `reuseCompletedStep` in
`packages/orchestrator/src/workflow-orchestrator.ts` keys reuse of a prior
step run on `(nodeId, stepId, iteration, idempotencyKey)`. The refused plan
step already has a completed step run at `iteration: 1` with a stable
idempotency key. Re-planning at `iteration: 1` would let `reuseCompletedStep`
serve that same refused artifact straight back out of the store, making the
end-of-graph re-assertion a silent no-op that always repeats the original
refusal without ever giving the tester a chance to see the now-finished
graph. Running the re-assertion in a band no attempt occupies is what makes
it a second, independent look rather than a cache hit on the first one.

**The alternative rejected: teach the defer point to look ahead itself.** A
plan refusing at task Tn could, in principle, ask "does any task after Tn make
this reachable?" and defer only if the answer is yes. That requires mapping
`nextActions` — free-form prose written by the browser-test agent — onto a
task id in the graph, reliably, without the graph's own execution having
happened yet. There is no such mapping today, and building one would mean
teaching the harness to parse intent out of natural language it does not
control the shape of. Waiting until the graph has actually finished and
re-asserting answers the identical question empirically: if the surface is
reachable now, the second assertion passes; if it is not, the tester refuses
again and the run fails on the same verdict it would have failed on anyway.

## Consequences

A refusal on the *last* task in the graph now costs one extra browser-plan
agent call before the run fails, where before it failed immediately on the
first refusal. That is the price of not building a lookahead: every deferral,
including ones that can never resolve, waits for the graph to finish before
paying for a second opinion.

Because a browser-visible task always runs solo on the primary checkout (the
pooled walk's `solo` gate breaks the dispatch loop for any task carrying
browser acceptance), the deferred iteration band can never collide with a
conflict-retry attempt band from a *concurrently running* task — there isn't
one. That non-collision is a consequence of the solo rule already in place
for browser-visible tasks, not of `deferredIterationBase`'s arithmetic; the
arithmetic only has to clear every band a single task's own attempts and
conflict retries could reach, which it does by construction.

`quality.deferred` joins `quality.approved` and `quality.repair_requested` in
`ProjectEventSchema` as a third terminal-ish verdict for a browser plan step,
but it is not itself terminal — a reader that treats any `quality.*` event as
the end of the story for a task will misread a deferral as done. The
authoritative signal that a deferred task's acceptance is finally settled is
a later `quality.approved` (or a run failure) against the same task id, not
the `quality.deferred` event itself.
