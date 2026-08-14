# Plan — #520 [HA-D.3] Orchestrator-side parallel Codex process pool

**Spec:** GitHub issue [#520](https://github.com/eedsilva/agent-foundry/issues/520) (parent [#472](https://github.com/eedsilva/agent-foundry/issues/472)).
**Primary evidence:** `docs/evidence/harness-alignment/cli-capabilities.md` (§2a, §3 Test 2, §4, §5 item 1).
**Branch:** `feat/520-parallel-codex-pool` (worktree at `../af-520-parallel-codex`).

## Spec restated (the binding authority)

Acceptance criteria, verbatim from #520:

1. Configurable concurrency cap enforced by the orchestrator itself (Codex CLI does not
   coordinate this across independent processes).
2. Each concurrent task runs in its own git worktree — reuses the isolation pattern Claude
   Code's own `isolation: worktree` subagent field already validates.
3. Failure detection reads exit code + `--json` stdout JSONL, never `stderr` (confirmed empty
   of diagnostic content for a real process failure in #482's Test 2).
4. Result-collection API integrates with the existing task graph runner.
5. At least one tracer shape rerun in real mode with parallel Codex tasks enabled, as the
   regression net.

Out of scope (from the issue): native Codex `multi_agent`; rate-limit-window-aware backoff
(#523); concurrent `apply_patch` contention against a *shared* workspace (#521).

## Where the code stands today

- `TaskGraphRunner.runTraced` (`packages/orchestrator/src/task-graph-runner.ts:139-148`) walks
  the graph strictly one task at a time via `nextReadyTask`. ADR 0043 says why: "One git
  checkout means one task at a time; parallel tasks would need worktrees and are not in this
  change." This ticket is that change.
- `BaseCliExecutor` (`packages/executors/src/base-cli-executor.ts:167-184`) already fails on
  exit code and already reads `stdout` for the reason — but `extractCliFailure`
  (`packages/executors/src/json-output.ts:160-173`) short-circuits for every provider except
  `claude`, so a Codex failure surfaces as a bare exit code. AC3 is a real gap.
- `cwd` is stripped from the execution-plane wire contract
  (`packages/contracts/src/execution-plane.ts:25`); the request carries
  `workspace: { projectId, ref }` and `LocalExecutionPlane`
  (`packages/executors/src/local-execution-plane.ts:64`) re-derives the host path from
  `workspaces.workspacePath(projectId)`. That single line is the isolation hook point.
- `FileWorkspaceManager` (`packages/persistence/src/workspace-manager.ts`) shells out with
  `execa('git', [...], { cwd })`. Every method is keyed by `projectId` only. Nothing in the
  repo creates a `git worktree` today.
- Runtime configuration: `packages/composition/src/config.ts` (`ConfigSchema` →
  `RuntimeConfig` → `runtime.ts` hand-threading). `AGENT_TIMEOUT_MS` → `agentTimeoutMs` →
  `OrchestratorOptions` is the pattern to copy.

## Design

**One shared idea:** a *worktree label* — not a host path — is the isolation unit. It is a
`PathSegment`-safe string threaded from the runner down to the execution plane; only
`FileWorkspaceManager` knows it resolves to `<projectRoot>/worktrees/<label>`. Host paths stay
out of the plane contract, so a future remote plane can interpret the label its own way.

**Global constraints binding every task:**

- `exactOptionalPropertyTypes` is on. An optional field is spread conditionally
  (`...(x !== undefined ? { x } : {})`), never assigned `undefined`.
- Every task ends with `npx tsc -b` clean for the packages it touched, plus the test files it
  touched run green. Vitest-only verification has twice let `tsc` errors through review here.
- Default behaviour must be byte-identical to today: with the concurrency cap at its default
  of `1`, no worktree is created, no new git command runs, and the walk is the same sequential
  walk ADR 0043 describes. Every existing test must pass unchanged.
- No new runtime dependency. `execa` and `zod` are already here.
- Concurrency is enforced by the orchestrator, never by trusting a CLI flag.

### Task 1 — Codex JSONL failure extraction (AC3)

`packages/executors/src/json-output.ts` + `json-output.test.ts`.

`extractCliFailure` gains a `codex` branch that scans the stdout JSONL for the terminal failure
records #482 Test 2 observed verbatim:

```json
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{...\"message\":\"The 'x' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"...same message..."}}
```

Rules:

- Prefer the last `turn.failed` record's `error.message`; fall back to the last `type: "error"`
  record's `message`. Return `undefined` when neither is present (bare exit code, as today).
- `message` may itself be a JSON-encoded envelope (as above). If it parses as JSON and carries
  `error.message`, unwrap to that inner human-readable string; otherwise use it as-is.
- `authFailure` keys on structure, never prose — mirroring the Claude branch's comment. Codex
  has no `subtype`; use the unwrapped envelope's `status === 401` or its
  `error.type === 'authentication_error'`. A 400 invalid-model failure is **not** an auth
  failure.
- `stderr` is not read. Do not add a `stderr` argument to this function.
- Update the `ponytail:` comment at `json-output.ts:164-165` — it says Codex emits no
  structured terminal failure record, which this task disproves.

Tests (TDD, red first): a `turn.failed` with a JSON-envelope message unwraps to the inner text;
a bare `type: "error"` line with no `turn.failed` is used; a 401 envelope sets
`authFailure: true`; a 400 invalid-model envelope sets `authFailure: false`; a clean
`turn.completed` stream returns `undefined`; malformed JSON lines are skipped, not thrown on.

### Task 2 — `readyTasks` frontier (supports AC1/AC4)

`packages/domain/src/task-graph.ts` + `task-graph.test.ts`.

Add `readyTasks(tasks, completed, running?): PlanTask[]` — every task not completed, not in
`running`, whose `dependsOn` are all in `completed`, in declaration order. Re-express
`nextReadyTask` as `readyTasks(tasks, completed)[0]` so there is one frontier rule, not two.
Keep `nextReadyTask`'s exported signature and doc comment intact — it has other callers and
its own tests.

Tests: empty `running` reproduces `nextReadyTask`; a running task is not re-offered; two
independent tasks both appear; a task blocked by a *running* (not completed) dependency does
not appear.

### Task 3 — Worktree lifecycle on `WorkspaceManager` (AC2)

`packages/domain/src/ports.ts` + `packages/persistence/src/workspace-manager.ts` +
`workspace-manager.test.ts`.

Port additions:

```ts
/** Creates an isolated git worktree of the project's workspace at HEAD (#520). */
createWorktree(projectId: string, label: string): Promise<void>;
/**
 * Merges the worktree's branch back into the primary checkout. Throws on
 * conflict, leaving the primary checkout unmerged-free (`merge --abort`).
 */
integrateWorktree(projectId: string, label: string): Promise<void>;
/** Removes the worktree and its branch. Safe to call twice. */
removeWorktree(projectId: string, label: string): Promise<void>;
```

`workspacePath(projectId)` gains an optional second parameter:
`workspacePath(projectId: string, worktree?: string): string` — with `worktree` it returns
`join(projectRoot(projectId), 'worktrees', safeSegment(worktree))`, otherwise today's
`join(projectRoot, 'workspace')` unchanged.

The same optional trailing `worktree?: string` is added to the git methods the per-task loop
uses: `checkpoint`, `rollback`, `commit`, `head`, `isClean`. Each resolves its `cwd` through
`workspacePath(projectId, worktree)`; every existing call site omits it and is unaffected.

`FileWorkspaceManager` implementation notes:

- `createWorktree`: `ensureGit` first, then
  `git worktree add -b af/task/<label> <path> HEAD` from the primary checkout.
- After creating it, if `<workspace>/node_modules` exists, symlink it into the worktree
  (`fs.symlink`). A fresh worktree has no `node_modules`, and the per-task verify step runs
  the generated app's own scripts — without this every parallel task's verification fails on a
  missing dependency. Mark with a `ponytail:` comment naming the ceiling (a symlink shares one
  install; per-worktree installs only if two tasks ever need different dependency trees).
- `integrateWorktree`: from the primary checkout,
  `git merge --no-ff --no-edit af/task/<label>`; on nonzero exit run `git merge --abort` and
  throw `ExecutionError` naming the label and git's stdout+stderr. Conflict handling is the
  caller's problem (Task 5 retries the task serially).
- `removeWorktree`: `git worktree remove --force <path>` then `git branch -D af/task/<label>`,
  both with `reject: false` so a second call is a no-op.
- `cleanup(projectId)` is `rm -rf projectRoot`; keep worktrees *under* `projectRoot` so that
  still tears everything down. Add `git worktree prune` before the `rm` is **not** needed
  (the whole repo goes), but the `worktrees/` directory must be inside `projectRoot`.
- `.gitignore` seeding: the worktree path is outside `workspace/`, so nothing to ignore.

Tests: create → the path exists and is a git worktree (`git rev-parse --show-toplevel` inside
it resolves to itself); a commit made inside the worktree is absent from the primary checkout
until `integrateWorktree`, and present after; `integrateWorktree` on two worktrees that touched
different files merges both; a genuine conflict (both worktrees edit the same line) throws and
leaves the primary checkout clean (`isClean` true, no `MERGE_HEAD`); `removeWorktree` is
idempotent; `node_modules` present in the primary is reachable from the worktree.

### Task 4 — Worktree-aware step execution (AC2/AC4 plumbing)

`packages/contracts/src/execution-plane.ts`, `packages/executors/src/local-execution-plane.ts`,
`packages/orchestrator/src/workflow-orchestrator.ts`, plus the tests for each.

- `ExecutionWorkspaceSnapshotSchema` gains `worktree: PathSegmentSchema.optional()` (a label,
  not a path). Update `execution-plane.test.ts`.
- `LocalExecutionPlane` widens its `Pick<WorkspaceManager, 'workspacePath'>` usage to pass the
  label through: `workspacePath(projectId, parsedRequest.workspace.worktree)`.
- `TaskGraphStepExecution` (`task-graph-runner.ts:51-61`) gains `worktree?: string`. The
  orchestrator's inline `TaskGraphRuntime.executeStep` adapter
  (`workflow-orchestrator.ts:385`) threads it into the workspace snapshot built at
  `workflow-orchestrator.ts:3600`, and into the per-step `checkpoint` / `rollback` / `commit` /
  `head` calls that bracket that step (`:2956`, `:2978`, `:3069`, `:3139`, `:3294`, `:3304`,
  `:2125`, `:2131`), and into the verification service's `workspacePath` (`:2339`) and the
  prompt-rendered `workspacePath` (`:3127`) and `writeRunContext`'s target (`:3130`).
- Trace every one of those call sites and thread the label; do not guess from this list, it is
  a starting map, not a contract. Anything that legitimately stays on the primary checkout
  (preview sessions `:454`/`:2701`, migrations `:2096`/`:2650`, `listFiles`) stays — record
  which and why in the report.
- Nothing else changes behaviour: with `worktree` absent every path resolves exactly as today.

Tests: an execution request carrying a `worktree` label runs the executor with the worktree's
`cwd` (local plane unit test with a fake workspace manager); the snapshot schema round-trips
with and without the field; an orchestrator-level test that a step given a worktree label
checkpoints and commits inside the worktree, not the primary checkout.

### Task 5 — Bounded parallel frontier in `TaskGraphRunner` (AC1/AC4)

`packages/composition/src/config.ts`, `packages/composition/src/runtime.ts`,
`packages/orchestrator/src/workflow-orchestrator.ts` (options + construction),
`packages/orchestrator/src/task-graph-runner.ts` + `task-graph-runner.test.ts`.

Config: `MAX_PARALLEL_TASKS: z.coerce.number().int().min(1).max(8).default(1)` →
`RuntimeConfig.maxParallelTasks` → `OrchestratorOptions.maxParallelTasks` →
`TaskGraphRunnerDependencies.maxParallelTasks`. Default `1` is the conservative default the
issue asks for: one ChatGPT account, one shared 5-hour/weekly rate-limit pool. Document the
cap's *reason* in the schema comment, not just its value. `TaskGraphRunner` must clamp
defensively too — it is the component the AC says enforces the cap.

Scheduler, replacing the `while (completed.size < tasks.length)` loop:

- `maxParallelTasks === 1` → the existing sequential path, unchanged, with no worktree label.
  This branch must remain literally the code that runs today.
- Otherwise: fill up to `maxParallelTasks` slots from `readyTasks(tasks, completed, running)`,
  each slot running `executeTask` with a worktree label derived from the task id and run id
  (`safeSegment`-able, unique per run). `await Promise.race` on the in-flight set; as each
  settles, integrate and mark complete, then refill.
- **Integration is serialized.** Merging into the primary checkout is a critical section: keep
  a single promise chain (or an explicit mutex) so exactly one `integrateWorktree` runs at a
  time. Two concurrent merges into one checkout is the corruption case this whole ticket
  exists to avoid.
- **Merge conflict is a task failure, not a run failure.** If `integrateWorktree` throws, the
  task's attempt is failed the way a `QualityGateError` attempt is failed today — emit
  `task.failed`, roll the worktree away, and let the existing attempt ladder retry it. The
  retry runs after its conflicting sibling has already landed, so it re-plans against the
  merged tree.
- **Browser-visible acceptance stays serial.** A task with `acceptanceMode: 'browser-visible'`
  drives a preview session bound to the primary workspace. Schedule such tasks alone: drain
  in-flight work first, run it on the primary checkout with no worktree, then resume filling.
  This is a deliberate limitation — record it in the ADR.
- **Cleanup always runs.** Every worktree is removed in a `finally`, success or failure, so a
  crashed run does not leave `.git/worktrees` entries behind.
- **Failure semantics are preserved.** A failing task still fails the node, and in-flight
  siblings are allowed to settle (or are cancelled via the existing `signal`) before the node
  throws — never leave an orphaned `codex exec` process. Tasks committed before the failure
  survive, exactly as ADR 0043 promises.
- Emit the concurrency actually used in the existing `task.started` event data
  (`parallelism: n`) so an operator can see whether the pool engaged.

Tests: cap of 1 is bit-identical to the current sequential behaviour (the existing suite
covers this — it must pass untouched); with a cap of 3 and three independent tasks, all three
start before any completes; a task with a dependency never starts before its blocker completes;
the cap is never exceeded (instrument the fake runtime with a high-water mark); a merge
conflict on integration fails that task and it is retried; a browser-visible task never runs
concurrently with another task; worktrees are removed on both the success and the failure path;
a cap above the max, or a non-numeric value, is rejected at config parse.

### Task 6 — ADR + operator docs

New `docs/adr/00NN-parallel-task-execution-uses-one-worktree-per-task.md` (take the next free
number), following the existing ADR shape (Status/Date/Owners/Context/Decision/Consequences).
It supersedes ADR 0043's "parallel tasks would need worktrees and are not in this change" —
say so explicitly and add a pointer line to ADR 0043 itself. Record: the go decision and its
two binding constraints from #482 §4, the label-not-path design, why the default is 1, the
merge-conflict-as-task-failure rule, and the browser-visible serialization limitation.

Also: `docs/OPERATIONS.md` gains `MAX_PARALLEL_TASKS` in whatever env-var table it already
keeps, and `CONTEXT.md` gets the one-line domain fact if it tracks execution concepts.

## Verification

Per task: the touched test files plus `npx tsc -b`. At the end: `npm run check` (full), logged
to a file with `echo $?` — a piped `tail` reports the pipe's status, not the command's.

AC5 (real-mode tracer with parallelism on) is run by the controller after the branch is green:

```bash
RUN_REAL_TRACER=true EXECUTOR_MODE=real MAX_PARALLEL_TASKS=3 \
CODEX_DEFAULT_MODEL=gpt-5.6-luna \
npx tsx scripts/tracer.ts --scenario toy --approve-gates \
  --data-dir <tmp>/520-datadir --executor-mode real
```

Evidence lands in `docs/evidence/harness-alignment/parallel-codex-pool-520/README.md`.
