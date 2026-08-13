# Plan — #537: a blocked implementation agent is verified and marked complete

Branch `fix/537-blocked-agent-not-complete`, base `d7bf246e` (`origin/main`).

## Context: what actually happens

`TaskGraphRunner.executeTask` runs the per-task implement step and then hands
its artifact straight to `verifyTask`
(`packages/orchestrator/src/task-graph-runner.ts:203-220`). Nothing between
those two calls looks at the agent's declared `status`. `AgentArtifactSchema`
(`packages/contracts/src/agent.ts:17`) allows `completed | needs-revision |
blocked`, and the only place in the runner that reads it is the browser-plan
step (`task-graph-runner.ts:443`), where `blocked` is a documented valid answer
("this task has no user-visible surface", `task-graph-runner.ts:768`).

So an implementation agent that says "I could not run a single command required
to produce the deliverable" is passed to the deterministic verifier, which
approves (its checks pass — nothing regressed, because nothing changed), and
`task.completed` is emitted. This is the run recorded in #537
(project `01KZWPC2R7C26NE2SER2SC4QZJ`, `implement.T2`).

## Global Constraints

- **`blocked` is a failed attempt, not an answer** — for a workspace-mutating
  agent in the task loop (implement, repair, browser repair). It stays a valid
  answer for the browser *plan* step, which is the one place the prompt asks
  for it.
- **The agent's own reason travels with the failure.** Both in the
  `task.failed` message and in machine-readable event data, following the
  `infrastructureFailure` precedent set by #528
  (`task-graph-runner.ts:274-278`).
- **Evidence is preserved.** The guard fires *after* `executeStep` has
  persisted the agent's report artifact and step attempt — never by refusing
  to record the agent's answer.
- **Route like a quality-gate failure.** Throwing `QualityGateError` (or a
  subclass) reuses the existing attempt ladder: rollback to the attempt
  checkpoint, `task.failed`, retry on the next executor, and a hard failure
  when the ladder is exhausted. No new control flow.
- Every task runs `npx vitest run <touched files>` **and** `npx tsc -b` for the
  packages it touches. Vitest alone does not catch
  `exactOptionalPropertyTypes` violations.
- No new dependencies. Smallest diff that holds.

## Scope ruling

The same "declared status is discarded" defect exists for node-level agent
steps outside the task graph (`workflow-orchestrator.ts:3252` emits
`agent.completed` with `status` and no one branches on it). This branch fixes
the task-graph path named in the issue; the node-level path is recorded as a
follow-up in the issue comment rather than widened into this PR.

## Task 1 — a blocked mutating agent fails its attempt

Files: `packages/domain/src/errors.ts`,
`packages/orchestrator/src/task-graph-runner.ts`,
`packages/orchestrator/src/task-graph-runner.test.ts`.

TDD, in this order:

1. Write failing tests in `task-graph-runner.test.ts` (the existing fixture
   harness at the top of that file, plus `blockedArtifact()` at line 1036):
   - implement step returns `status: 'blocked'` → no `task.completed` event for
     that task; run rejects; a `task.failed` event exists whose message
     contains the agent's `summary` and whose `data.blockedReason` equals that
     summary.
   - with `maxAttempts: 2` and a routing ladder, a blocked first attempt
     retries on the next executor and a `completed` second attempt still ends
     in `task.completed` (the guard must not break the ladder).
   - the verify **repair** step returning `blocked` fails the attempt the same
     way (gatedWorkflow fixture).
   - the browser **plan** step returning `blocked` still skips the assertion
     and completes the task — existing behaviour, keep it green (a test for
     this already exists around line 673; extend, don't duplicate).
2. Add `AgentBlockedError extends QualityGateError` to
   `packages/domain/src/errors.ts` carrying `readonly reason: string`, exported
   from the package index alongside `BrowserInfrastructureError`.
3. In `task-graph-runner.ts`, add one module-level helper:
   ```ts
   function assertAgentNotBlocked(
     artifact: StoredArtifact,
     context: { taskId: string; stepId: string; nodeId: string },
   ): void
   ```
   It `safeParse`s `AgentArtifactSchema` over `artifact.content`; when the
   parse succeeds and `status === 'blocked'`, it throws `AgentBlockedError`
   with a message naming the task, the step and the agent's `summary`.
   A parse failure is not this guard's business — leave it to the existing
   contract checks.
4. Call it at the three mutating-agent sites: the implement artifact in
   `executeTask`, the repair artifact in `verifyTask`, the browser repair
   artifact in `assertTask`. Do **not** call it on the browser plan artifact.
5. In the `executeTask` catch, attach the machine-readable field next to the
   existing `infrastructureFailure` spread:
   `...(error instanceof AgentBlockedError ? { blockedReason: error.reason } : {})`.

## Task 2 — the Bash permission denials

Files: `packages/executors/src/claude-executor.ts`,
`packages/executors/src/cli-executors.test.ts`, `docs/SECURITY.md`,
a new ADR under `docs/adr/`.

### The finding (investigated, not assumed)

`--permission-mode acceptEdits` (`claude-executor.ts:34-35`) auto-approves only
the Edit/Write family — never Bash. `--safe-mode` keeps the strict permission
engine on, and headless `-p` has no TTY to grant approval, so every Bash call
is denied with "This command requires approval". No `--allowedTools` is passed
anywhere. The Codex executor has no such wall: `--sandbox workspace-write` with
approvals off in non-interactive mode (`codex-executor.ts:44-55`,
`docs/SECURITY.md:92`). `docs/SECURITY.md:96` already flags Bash as an
uncovered surface ("Comandos shell adicionais podem depender das políticas
locais da CLI"), so this is an unintended consequence, not a designed policy.

There is no sandbox behind the executor: `LocalExecutionPlane` spawns the CLI
directly on the host workspace (ADR-0025 "Scope boundary" —
`DockerSandboxRunner` is preview-only).

### Decision (operator's call, taken 2026-08-13)

Pre-approve a **scoped** Bash allowlist for workspace-mutating runs only. Not
`bypassPermissions`, not a bare `Bash` wildcard: the permission engine stays
on, and commands outside the list stay denied, because agents run unsandboxed
on the host.

### Work

1. In `claude-executor.ts`, when `request.mutatesWorkspace` is true, append
   `--allowedTools` followed by the allowlist. The CLI's own help documents
   `--allowedTools, --allowed-tools <tools...>` taking space- or
   comma-separated tool names with patterns like `Bash(git *)`.
   Allowlist entries — the toolchain this repo's generated apps actually need
   (see the denied commands in #537): `pnpm`, `npm`, `npx`, `node`, `git`,
   `docker`, `supabase`, `psql`. Non-mutating (`plan`) runs get no allowlist.
2. **Verify the flag really works before believing it.** Run the real CLI once
   with the exact argv the executor now builds and a prompt that must shell
   out (e.g. `node -e "console.log(1+1)"` or `pnpm -v`), and confirm from the
   stream-json output that the Bash call executed instead of returning
   "requires approval". Also run one command *outside* the allowlist and
   confirm it is still denied. Paste both transcripts into the report — this
   is the task's acceptance evidence. If the pattern syntax turns out to be
   wrong (`Bash(pnpm:*)` vs `Bash(pnpm *)`), find the one that works and use
   it; do not guess.
3. Update the exact-argv assertions in `cli-executors.test.ts` (the
   `InspectableClaudeExecutor` cases around lines 91-102) — both the mutating
   case (allowlist present, exact contents) and the non-mutating case
   (no allowlist).
4. Update `docs/SECURITY.md`'s "Políticas por executor" section (line ~96,
   Portuguese, match the surrounding language and tone) to state the new
   policy accurately.
5. Write `docs/adr/0063-scoped-bash-allowlist-for-mutating-agents.md`
   following the format of the existing ADRs in that directory: the denial
   that motivated it (#537), the options weighed (leave denied / scoped
   allowlist / full bypass), the decision, and the consequence that an
   unsandboxed host makes the scope matter until an execution sandbox exists.

## Task 3 — record the outcome on the issue

Not a code task: a comment on #537 stating what changed, which acceptance
criterion each change satisfies, and the node-level follow-up from the scope
ruling above.
