# ADR 0064: Parallel task execution uses one worktree per task

- Status: Accepted
- Date: 2026-08-13
- Owners: Core
- Tracked by issue #520 (epic #472). Supersedes ADR 0043 on the sequential-walk point.

## Context

ADR 0043 gave `for-each-task` a single-checkout constraint by construction: "One git checkout
means one task at a time; parallel tasks would need worktrees and are not in this change." Epic
HA-D (#472) asked whether that constraint could be lifted using Codex CLI's own multi-agent
primitive instead of building isolation in the orchestrator. The research spike recorded in
`docs/evidence/harness-alignment/cli-capabilities.md` (from #482) answered that question and set
the terms this ticket had to build to.

§2a of that spike found Codex's `multi_agent` feature real — `codex features list` shows it
`stable`, enabled by default — but confined to `.codex/agents/*.toml` threads inside one
interactive session, invoked via `/agent` or natural-language delegation. No primary source in the
spike documents that mechanism as reachable from `codex exec`, the orchestrator's actual
non-interactive entry point; every described invocation path is interactive-session-shaped. The
only mechanism an external orchestrator can actually drive is spawning independent `codex exec`
processes and supervising them itself.

§3 Test 2 forced a process-level failure under concurrency (`-m
this-model-does-not-exist-xyz`, an invalid model ID) and read both output streams directly:
`stderr` for the failed process contained only `Reading additional input from stdin...` — not
informative on its own. The actual diagnostic — a `400 invalid_request_error` wrapped in a
`type: "error"` record, followed by a `turn.failed` record carrying the same message — lived
entirely in the `--json` stdout JSONL stream. The process's exit code (`1`) gave a correct
pass/fail signal on its own; the *reason* required parsing stdout, never stderr.

§4 recorded the go decision and two binding constraints that this ADR turns into orchestrator
behavior:

1. One ChatGPT account serves every concurrent `codex exec` process from the same 5-hour rolling
   plus weekly rate-limit pool (§2d, `codex doctor` plus the pricing docs: "the usage limits for
   local messages and cloud chats share a five-hour window"). Concurrency is a wall-clock
   multiplier only — it buys speed, never added capacity — and the orchestrator must enforce
   whatever cap it uses itself, since nothing in the CLI coordinates usage across independent
   processes.
2. Codex has no supervision or failure-propagation primitive reachable from `codex exec`,
   analogous to Claude Code's background-subagent completion-notification model. The orchestrator
   has to build process supervision, timeout handling, and result collection itself; there is
   nothing in Codex CLI to lean on for that layer.

## Decision

**Scheduler.** `TaskGraphRunner` (`packages/orchestrator/src/task-graph-runner.ts`) walks a task
graph's frontier — the set of tasks whose blockers have all completed — via `readyTasks(tasks,
completed, running)` (`packages/domain/src/task-graph.ts`), which also now backs the original
single-task `nextReadyTask(tasks, completed)` as `readyTasks(tasks, completed)[0]`. At the default
concurrency cap of 1 the walk is the same sequential `nextReadyTask` loop ADR 0043 describes, with
no worktree label assigned and no `git worktree` command run. Above 1, the scheduler fills up to
the cap's number of slots from the frontier and runs each concurrently, each against its own
worktree.

**Concurrency is enforced by the orchestrator, not the CLI.** Nothing in `codex exec` limits how
many invocations a caller runs at once, and nothing coordinates usage across them (§4 constraint
1). `TaskGraphRunner` is the sole enforcement point for the configured cap; it clamps defensively
rather than trusting an upstream value to already be in range.

**Default cap is 1.** `MAX_PARALLEL_TASKS` (`packages/composition/src/config.ts`) is bounded
`min(1).max(8)`. The default of 1 exists because one account draws from one shared rolling-window
pool (§4 constraint 1): a default above 1 would let an unmodified run consume more of that shared
quota per unit wall-clock time with no explicit operator opt-in, and would make the parallel path
the one every run exercises by default before it has had any real-world soak time. A default of 1
also gets the "existing behavior is unaffected" property for free, rather than as a special case
the scheduler has to preserve deliberately.

**A worktree label, not a host path, is the isolation unit.** The value threaded from the
scheduler down to the execution plane is a `PathSegment`-safe string
(`ExecutionWorkspaceSnapshotSchema.worktree`, `packages/contracts/src/execution-plane.ts`), not a
filesystem path. Only `FileWorkspaceManager` (`packages/persistence/src/workspace-manager.ts`)
knows a label resolves to `<projectRoot>/worktrees/<label>`; `LocalExecutionPlane` receives the
label on the wire and asks `workspaces.workspacePath(projectId, worktree)` for a `cwd`, never
building or being handed the path itself. This mirrors a boundary the execution-plane contract
already drew for the primary workspace — the wire request carries `workspace: { projectId, ref }`,
with no `cwd` field, and `LocalExecutionPlane` re-derives the host path locally. Putting a host
path on the wire instead of a label would undo that boundary and bind the contract to a local
execution plane's own filesystem layout, which a future remote plane would then have to either
match or reinterpret from scratch.

**Worktree lifecycle.** `WorkspaceManager` gained `createWorktree`, `integrateWorktree`, and
`removeWorktree`. `createWorktree` calls the idempotent `removeWorktree` first, then `git worktree
add -b af/task/<label> <path> HEAD` from the primary checkout, so a same-label branch or directory
left behind by a crashed prior run is reclaimed instead of permanently wedging the next run of
that label. If the primary checkout has a `node_modules`, it is symlinked into the new worktree —
a fresh worktree otherwise has none, and the per-task verify step runs the generated app's own
scripts against it. That symlink is a *tracked-file hazard*, not only a shared-install one:
`.gitignore`'s `node_modules/` is a directory-only pattern and git never treats a symlink as a
directory, so `checkpoint`'s `git add -A` would stage it, commit it onto `af/task/<label>` on the
first checkpoint after a fork, and `integrateWorktree` would merge it into the primary — replacing
the real install with a symlink pointing at itself and writing an absolute host path into the
generated project's history. `createWorktree` therefore adds `node_modules` (no trailing slash, so
it matches a symlink too) to the repository's `info/exclude` before creating the symlink. Git
resolves that file against `$GIT_COMMON_DIR`, so one write covers the primary and every worktree,
including projects scaffolded before this fix and scaffolds that ship their own `.gitignore`; a
per-worktree `.git/worktrees/<name>/info/exclude` is *not* read by git (verified against real
git), which is why the exclusion is deliberately shared rather than per-worktree. The remaining
ceiling is the shared install itself (`ponytail:` comment in `workspace-manager.ts`): every
parallel worktree shares one `node_modules`, and two tasks that need divergent dependency trees
would collide; a per-worktree `npm install` is the upgrade path if that ever happens.
`integrateWorktree` runs `git merge --no-ff --no-edit af/task/<label>` from the
primary checkout and, on nonzero exit, runs `git merge --abort` before throwing an
`ExecutionError` naming the label and git's stdout/stderr — the primary checkout is never left
mid-merge. `removeWorktree` (`git worktree remove --force`, then `git branch -D`) is idempotent,
tolerant of a second call against an already-removed label. Every worktree lives under
`<projectRoot>/worktrees/`, so `cleanup(projectId)`'s existing `rm -rf projectRoot` already tears
worktrees down with everything else.

**Integration is serialized.** Merging a worktree's branch back into the primary checkout is a
critical section: only one `integrateWorktree` call runs at a time, regardless of how many tasks
execute concurrently. Two concurrent merges into a single checkout is exactly the corruption this
ticket exists to prevent; nothing about `git worktree` or `git merge` makes that safe unsupervised.

**A merge conflict on integration is a task failure, not a run failure — and not a quality
failure.** When `integrateWorktree` throws, the scheduler re-forks that task's worktree from the
primary's now-merged HEAD and re-runs the task, emitting a `task.failed` carrying a `mergeConflict`
field so an operator can tell a conflict retry from a quality retry. The retry runs after the
conflicting sibling has already landed, so it plans and implements against the merged tree rather
than the stale fork point. Tasks that already integrated before the conflict keep their commits;
ADR 0043's guarantee — a failed attempt rolls back only that attempt's own checkpoint — holds
unchanged, because the checkpoint being discarded lives entirely inside the re-forked worktree.

Crucially the retry does **not** consume a rung of ADR 0043's `implement.maxAttempts` ladder and
does **not** advance the executor: a conflict is a scheduling collision between two tasks, not a
fault in either task's work, and charging it to the quality budget would let a lost merge race
spend an attempt — and switch agent — before anything had been attempted on the real problem. The
allowance is bounded at one conflict retry per task (`CONFLICT_RETRY_ALLOWANCE`,
`packages/orchestrator/src/task-graph-runner.ts`); a second conflict on the same task is no longer
a collision but a property of its own content, and converts to a `QualityGateError` that does spend
an attempt, so a pathologically conflicting task still terminates.

**Labels are unique per in-flight task by construction.** The scheduler derives a worktree label as
`<runId>-<nodeId>-<taskId>`, all three `PathSegment`-safe by schema. Uniqueness matters more than it
looks: `createWorktree` reclaims a stale label by *destroying* it, so two concurrent forks on one
label would silently delete each other's work rather than erroring. The guarantee comes from the
frontier, not from the string — `readyTasks(tasks, completed, running)` never dispatches a task id
already in flight, so any two simultaneously live tasks differ in `taskId` and therefore in label.
`runId` and `nodeId` are constant within one scheduler call; they buy cross-run and cross-node
separation on disk, not in-flight uniqueness. The label carries no attempt or retry component, so it
is stable across every retry of a task within a run — which the retry-directive rollback in
`WorkflowOrchestrator` depends on, and which is what lets a conflict retry re-fork by simply asking
for the same label again.

**A resumed run reuses labels deliberately.** A resumed run keeps its `runId`, so a crashed
attempt's `<projectRoot>/worktrees/<label>` directory and `af/task/<label>` branch are still on
disk under exactly the label the resumed task will ask for. `createWorktree`'s destructive reclaim
discards that dead attempt's commits and restarts from the primary's current HEAD — which is the
correct base, and is precisely the state the old `resumedFailure.checkpoint` rollback existed to
produce. That is why the scheduler ignores a resumed checkpoint for an isolated task: the sha names
a commit in the *primary* checkout left by a previous process, the fresh worktree already starts at
the primary's current HEAD, and rolling a worktree back to it would be either a no-op or wrong. The
resumed attempt number and routing index are still honoured, so the ladder resumes on the right
rung.

**Failure detection reads exit code and `--json` stdout JSONL, never `stderr`.** `extractCliFailure`
(`packages/executors/src/json-output.ts`) gained a Codex branch (`extractCodexFailure`) that scans
the stdout JSONL for the last `turn.failed` record's `error.message`, falling back to the last
bare `type: "error"` record when no `turn.failed` is present; a message that itself parses as a
JSON envelope carrying `error.message` is unwrapped to that inner string, and `authFailure` is
derived from the envelope's structure (`status === 401` or `error.type ===
'authentication_error'`), never from prose, so a 400 invalid-model failure does not read as an
auth failure. `stderr` is not read for this purpose anywhere in the function. This follows directly
from §3 Test 2: Codex's `stderr` carried no diagnostic content for a real process failure, while
the terminal-failure record and its message lived entirely in stdout.

**Browser-visible acceptance is scheduled alone, on the primary checkout.** A task whose
acceptance channel is `browser-visible` drives a live preview session, and preview sessions boot
only against the primary workspace (`bootWorkspacePreview` in `workflow-orchestrator.ts`) — there
is no per-worktree preview. The browser-check step stays on the primary checkout unconditionally,
regardless of which worktree the step that produced its plan ran in. The scheduler drains
in-flight parallel work before running a browser-visible task, runs it alone with no worktree, and
only then resumes filling. This is a deliberate limitation, not an oversight left for later:
extending preview sessions to run per-worktree is out of scope for #520.

**Worktree-scoped verification does not advance the run-level `lastVerifiedCheckpoint`.**
`run.execution.lastVerifiedCheckpoint` is read and reset entirely against the primary checkout by
the emergency-ceiling machinery (`preserveDraft`/`discardDraft`/`getDraft`, ADR 0016) — none of its
consumers accept a worktree parameter, and a per-task worktree sha is not a valid value for any of
them: recording one would point a future ceiling rollback or draft-preserve at unmerged,
eventually-discarded task history instead of the primary checkout's own commit history. A verify
step that ran inside a worktree still checkpoints as usual, but the write to
`lastVerifiedCheckpoint` is skipped when `worktree !== undefined`; the anchor keeps whatever the
last primary-scoped verified checkpoint was, which is exactly its pre-#520 meaning. The cost is
real: during a long parallel stretch the anchor can lag behind work already integrated into the
primary, so an emergency-ceiling draft may preserve less recent work than it could. That is
recoverable and strictly safer than teaching three separate ceiling-draft consumers to interpret a
worktree-scoped sha they were never designed to accept.

## Alternatives considered

- **Native Codex `multi_agent`.** Rejected on §2a's evidence: every documented invocation path is
  shaped for one live interactive session (`/agent`, natural-language delegation), and no primary
  source describes `.codex/agents/*.toml` threads as reachable from `codex exec`. An external
  orchestrator cannot drive a mechanism that only exists inside an interactive session it isn't
  running.
- **Rate-limit-aware dynamic concurrency**, instead of a static cap. Deferred, not rejected — the
  spike's §5 item 4 records this as a contingent follow-up (#523), to be evaluated once a static
  cap is running and its effect on the shared quota pool has actually been observed. Building
  dynamic throttling now would be tuning against a pool this ticket never measured occupancy
  patterns for.
- **A host path, instead of a label, on the execution-plane wire contract.** Rejected — the
  contract already strips `cwd` for the primary-workspace case; putting a worktree host path on
  the wire would reintroduce exactly the local-plane assumption that omission avoided, and would
  need to change again the day a remote execution plane exists.

## Consequences

- Independent tasks in a task graph can run concurrently, each isolated in its own git worktree,
  with default behavior (cap of 1) unchanged from pre-#520 — an operator opts into parallelism
  explicitly via `MAX_PARALLEL_TASKS`.
- Codex failure attribution is now accurate. Before this ticket, `extractCliFailure`
  short-circuited to `undefined` for every provider except `claude`, so a Codex process failure
  surfaced only as a bare exit code with no reason attached; the stdout-JSONL scan this ADR
  describes closes that gap using the same evidence (§3 Test 2) that shaped the parallelism design
  itself.
- Negative / operational: parallel worktrees share a single `node_modules` install by symlink, a
  named ceiling — two concurrent tasks needing divergent dependency trees will collide, and the
  fix (per-worktree installs) is deferred until that actually happens. The symlink is kept out of
  git by a `node_modules` line in the repository's shared `info/exclude`, written by
  `createWorktree`; the directory-only `node_modules/` in the project's `.gitignore` does not
  match a symlink and is not sufficient on its own.
- Negative / operational: integration is serialized by construction, so raising the cap speeds up
  implementation and per-task verification, not the merge step — a task graph with many small,
  frequently-conflicting tasks benefits less from a higher cap than one with few, large,
  independent tasks.
- Negative / operational: the emergency-ceiling anchor (`lastVerifiedCheckpoint`) can lag behind
  actually-integrated progress during a parallel stretch, as described in the Decision section — a
  bounded, recoverable cost, not a correctness gap.
- Negative / operational: browser-visible tasks never run inside the pool and force a
  serialization point around themselves (drain in-flight work, run alone, resume filling) — a task
  graph that interleaves many browser-visible tasks with deterministic ones sees less concurrency
  in practice than the configured cap alone would suggest.
- Risk carried forward, not closed here: workspace contention beyond a trivial shell append is
  still unproven (spike §3 Test 3's caveat, §4 constraint 3). This ticket's answer — one worktree
  per task — sidesteps that open question rather than resolving it; two Codex processes running
  `apply_patch`-style edits against the *same* file or working tree remains untested and is
  tracked as its own follow-up (the spike's drafted ticket 2, concurrent `apply_patch`/file-edit
  contention).

This ADR supersedes ADR 0043 on the sequential-walk point: 0043's line "One git checkout means one
task at a time; parallel tasks would need worktrees and are not in this change" is exactly the
constraint #520 removes. ADR 0043's decision is otherwise unchanged — one `for-each-task` node
type, the per-task attempt ladder, one commit per task, and pause/resume at the orchestrator seam
all stand as written there.
