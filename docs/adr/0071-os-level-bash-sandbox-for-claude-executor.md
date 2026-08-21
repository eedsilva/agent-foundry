# ADR 0071: OS-level Bash sandbox closes the Claude executor's workspace-boundary gap

- Status: Accepted
- Date: 2026-08-21
- Owners: Security
- Tracked by issue #565

## Context

ADR-0063 shipped a scoped Bash allowlist (`pnpm`, `npm`, `npx`, `node`, `git`,
`docker`, `supabase`, `psql`) so mutating Claude runs could execute their own
toolchain, and named the residual risk explicitly: "any agent that can invoke
an allowlisted binary can chain arbitrary shell commands after it... Closing
that gap needs either shell-free invocation... or a real execution sandbox;
neither exists yet." #565 is that gap, generalized: no code path stops a
model-invoked tool call from reading, writing, or executing outside its
run's workspace. `LocalExecutionPlane` — the only `ExecutionPlane` wired into
production (`packages/composition/src/runtime.ts:316`) — spawns the `claude`/
`codex` CLI directly on the host with no containment of its own
(`packages/executors/src/base-cli-executor.ts`). Every project's workspace
lives as a sibling directory under one shared root
(`FileWorkspaceManager`: `<dataDir>/projects/<projectId>/workspace`), so an
escape is not hypothetical: it reaches every other project's files, blob
storage, and any host secret the control-plane process itself can read.

**Reproduced, not assumed.** Against the exact argv `ClaudeCliExecutor`
builds for a mutating run (`--permission-mode acceptEdits` plus the ADR-0063
allowlist, headless `-p`, no TTY):

- Reading a file outside the workspace through the Read tool — by relative
  traversal (`../secret.txt`), an absolute path, or a symlink whose target
  resolves outside the workspace — is already denied by Claude Code's own
  default (`Read` requires approval outside the working directory; headless
  mode has no TTY to grant it, so it fails closed:
  `"Claude requested permissions to read from ..., but you haven't granted it
  yet."`). This part of the model's own tool surface was never the gap.
- The gap is the Bash tool. With the *exact* production allowlist and
  `acceptEdits`, the prompt "run `node -e
  \"console.log(require('fs').readFileSync('<path-outside-workspace>','utf8'))\")\"`
  produces a single allowlisted `Bash(node *)` call that reads the file and
  returns its contents verbatim — no permission denial, because Claude
  Code's `Read`/`Edit` deny rules "apply to Claude's built-in file tools...
  They don't apply to arbitrary subprocesses that read or write files
  indirectly, like a Python or Node script that opens files itself" (Claude
  Code docs, "Read and Edit" — <https://code.claude.com/docs/en/permissions>).
  Any of the eight allowlisted binaries can be used this way; `node` was
  used only because it needed no extra tooling to reproduce.
- Codex's `--sandbox workspace-write` has the identical gap in the opposite
  direction: it restricts **writes** to the working directory but not reads.
  The same `node -e readFileSync(...)` prompt against the real `codex exec
  --sandbox workspace-write` argv returned the file's contents with exit code
  0. Confirmed against source, not just behavior: Codex's `SandboxPolicy`
  (`codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts`)
  has exactly four variants — `dangerFullAccess`, `readOnly`,
  `externalSandbox`, `workspaceWrite` — and `workspaceWrite`'s own fields are
  `writable_roots`, `network_access`, `exclude_tmpdir_env_var`,
  `exclude_slash_tmp`. There is no read-path restriction field anywhere in
  the policy. Codex cannot be configured to close this gap today.

## Decision

Enable Claude Code's built-in OS-level Bash sandbox
(<https://code.claude.com/docs/en/sandboxing>, Seatbelt on macOS, bubblewrap
on Linux/WSL2) on every Claude invocation via a per-request `--settings`
JSON blob, scoped to the run's own workspace:

```json
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "filesystem": {
      "denyRead": ["<realpath(workspaceRoot)>", "<realpath(tmpdir())>"],
      "allowRead": ["<realpath(request.cwd)>"]
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh", "mode": "deny" },
        { "path": "~/.aws/credentials", "mode": "deny" },
        { "path": "~/.claude/.credentials.json", "mode": "deny" },
        { "path": "~/.netrc", "mode": "deny" },
        { "path": "~/.docker/config.json", "mode": "deny" },
        { "path": "~/.npmrc", "mode": "deny" }
      ]
    },
    "network": { "allowedDomains": ["*"] },
    "excludedCommands": ["docker *"]
  }
}
```

(This is the settled shape after a review round caught three real gaps in an
earlier version — `denyRead: [workspaceRoot]` only, no `credentials.files`,
and `path.resolve()` instead of `realpath()`. See "Review round" below for
what each reproduction found and how it was closed; the shape above is
already corrected.)

- **`denyRead: [workspaceRoot]` + `allowRead: [cwd]`**, not `denyRead:
  ["/"]`. The sandbox's filesystem model reads broadly by design — the
  default is "the entire computer, except certain denied directories"
  (Claude Code docs, "How sandboxing works") — because tools legitimately
  need to read system libraries, the dynamic linker, global caches. Denying
  the whole filesystem root breaks that: reproduced empirically, `denyRead:
  ["/"]` made `node` itself abort (exit 134, native crash trying to load its
  own shared libraries) and `cat` fail with `Operation not permitted` even
  for a file *inside* the allowed workspace. Denying only the shared
  workspaces root (`config.dataDir` — the parent of every project's
  workspace and of the fs-mode blob store) and re-opening this run's own
  `cwd` leaves system/toolchain reads untouched while blocking exactly the
  cross-project and host-secret escape: verified against the reproduction
  above — the same `node -e readFileSync(<sibling-directory-file>)` call now
  fails with `EPERM: operation not permitted`, a **symlink** pointing from
  inside the workspace to a sibling directory fails the same way (the
  sandbox resolves the real target, unlike a string-only path check), and
  `cat inside.txt` for a file actually inside the workspace still succeeds.
- **`denyRead` also includes `tmpdir()`, and `credentials.files` denies
  common host credential locations.** Neither was in the version first
  reviewed — both are real, reproduced gaps, not theoretical. `denyRead:
  [workspaceRoot]` alone says nothing about paths outside it: with only that
  entry, `node -e readFileSync('$HOME/.claude/.credentials.json')` and
  `node -e readFileSync('<os.tmpdir()>/bait.txt')` both returned their
  contents, exit 0, no denial — the sandbox's own docs say this
  outright ("this default still allows reading credential files such as
  `~/.aws/credentials` and `~/.ssh/`"), but the first version of this ADR
  didn't act on it. Re-reproduced after adding `tmpdir()` to `denyRead` and
  the `credentials.files` deny list above: both reads now fail with `EPERM`,
  while `cat inside.txt` and `npm --version` inside the workspace still
  succeed.
- **`network.allowedDomains: ["*"]`.** #565's acceptance criteria is a
  filesystem boundary, not a network policy. The sandbox's network layer is
  independently fail-closed by default (no domain pre-allowed; a headless
  run with no TTY gets `deny network-outbound <host>:443 (user denied)`,
  reproduced with a plain `git ls-remote` over HTTPS). Guessing at a static
  allowlist for whatever `npm`/`git`/`docker`/`supabase`/`psql` need to
  reach (registry mirrors, arbitrary git remotes, project-specific Supabase
  and Postgres hosts) risks silently breaking every mutating run's toolchain
  in production. `allowedDomains: ["*"]` keeps network egress exactly as
  unrestricted as it was before this change; tightening it is future work
  with its own review, not bundled into a filesystem-boundary fix.
- **`excludedCommands: ["docker *"]`.** Docker cannot run inside this
  sandbox at all (Claude Code's own troubleshooting docs: "`docker`
  commands fail: `docker` is incompatible with the sandbox"), so it must be
  excluded or every `docker`-allowlisted call would break. `docker` stays on
  `MUTATING_BASH_ALLOWLIST` and runs exactly as unconfined as every entry did
  before this change — see Consequences for why that residual gap is
  accepted rather than fixed here.
- **`failIfUnavailable: true`, `allowUnsandboxedCommands: false`.**
  Default-deny: a host missing the sandbox dependency (or a retry that tries
  to fall back to unsandboxed execution) must fail the run, not silently
  execute the model's tools unconfined.
- **`workspaceRoot` is threaded per executor construction, not
  per-request.** `ClaudeCliExecutor` takes it as a constructor argument;
  production wiring (`runtime.ts`) passes `config.dataDir` — the same root
  `FileWorkspaceManager` derives every project's workspace from. The
  provider-canary executors (`provider-canary.ts`) pass `tmpdir()` instead,
  since `createFixtureWorkspace` `mkdtemp`s each canary run's fixture
  directly under the OS temp dir, not under `dataDir`.
- **`workspaceRoot`, `cwd`, and `tmpdir()` are each passed through
  `fs.realpath()` before being written into `--settings`, not just
  `path.resolve()`.** Reproduced empirically as a real, silent bypass, not a
  theoretical one: `config.dataDir = resolve(rootDir, DATA_DIR)`
  (`config.ts`) never resolves symlinks, and neither did the first version
  of `ClaudeCliExecutor`. When `denyRead`/`allowRead` are written as a
  symlink path (`/tmp` itself is one on macOS — `/tmp` → `/private/tmp` —
  and container volume mounts routinely are too), the sandbox does not
  error and does not fall back to some safe default: it just fails to match
  anything, silently. Reproduced with a `data-link -> data-real` symlink
  standing in for `config.dataDir`: with `denyRead`/`allowRead` written in
  the symlink form, `node -e readFileSync('<sibling file, symlink-form
  path>')` returned the sibling's contents, exit 0 — the exact literal path
  named in `denyRead` was itself readable. Rewriting the same settings with
  `realpath()`-resolved paths (identical directories, identical request)
  fixed it: the same read failed with `EPERM`. This is the same bug class
  `FileWorkspaceManager.readWorkspaceFile` already had to be hardened
  against below — a symlink defeating a string-only containment check —
  just surfacing through a different code path (the sandbox's own path
  matcher instead of `path.relative`).
- **Symlink hardening for the human Files-tab API too.**
  `resolveWorkspaceRelativePath` (the shared containment check) only
  validates the literal path string; `FileWorkspaceManager.readWorkspaceFile`
  now also resolves both the workspace root and the target through
  `fs.realpath` and re-checks containment before opening the file, so a
  symlink planted inside a workspace pointing outside it can no longer be
  read through this API either. `sandbox-runner.ts`'s `isAllowed` (Docker
  preview-snapshot filtering) is left as-is: it operates on paths already
  reported from inside `DockerSandboxRunner`'s own hardened, read-only,
  tmpfs-workspace container, a materially smaller blast radius than a raw
  host path, and out of this issue's model-tool-call scope.

## Alternatives considered

- **Wrap every executor's subprocess spawn in a hand-rolled OS sandbox at
  `BaseCliExecutor.executeInvocation`**, giving Claude and Codex identical,
  provider-agnostic confinement. Rejected for this issue: it would mean
  reimplementing (or newly depending on) Seatbelt/bubblewrap wiring, mount
  tables, stdio/signal passthrough through a wrapper process, and platform
  detection — a materially larger, separate engineering effort with its own
  regression surface across every existing executor test, not a
  configuration change. Tracked as follow-up work for Codex (see
  Consequences); the Claude-side fix ships now because it's a native,
  already-shipped, empirically-verified capability of the CLI already in
  this dependency tree.
- **`sandbox.filesystem.denyRead: ["/"]`** (deny everything, allow only
  cwd). Rejected — reproduced as breaking basic toolchain reads (node
  crashes, `cat` fails inside its own allowed directory); see Decision.
- **Leave the allowlist as the only control (ADR-0063's status quo).**
  Rejected — this is precisely the gap ADR-0063 named as unclosed and #565
  exists to close, and it was reproduced as a live, working exfiltration
  path in this ADR's Context.
- **A static `network.allowedDomains` allowlist tuned to known
  registries/hosts.** Deferred, not rejected outright — #565's acceptance
  criteria doesn't ask for network policy, and getting the list wrong risks
  breaking every mutating run's `npm install`/`git push`/`psql` in
  production without the domain inventory to get it right confidently. A
  future issue can tighten this once the actual hosts each deployment needs
  are enumerated.

## Review round

A review of the first version of this change (PR #638) raised five points
against the shipped code and this ADR. Each was checked against a live
reproduction, not accepted or dismissed on argument alone:

1. **Codex is wired into production (`runtime.ts:311-314`) and #565's
   acceptance criteria says "ferramentas do modelo," not "the Claude
   executor."** Correct, and already the framing in this ADR's Consequences
   and #637 — restated here because it's a scope decision for the issue
   owner, not something this ADR can resolve unilaterally: whether #565
   stays open until #637 lands, or is rescoped to the Claude executor
   specifically with #637 promoted to a sibling under the same parent (#100).
2. **`denyRead: [workspaceRoot]` alone leaves CLI credentials and OS temp
   directories readable — AC3 and AC5.** Confirmed exactly as reported, by
   reproduction, not assumption: see the `denyRead`/`credentials.files`
   bullets above. Both are fixed in this version.
3. **`workspaceRoot`/`cwd` used `path.resolve()`, not `fs.realpath()` — same
   bug class as the `readWorkspaceFile` fix in this same PR.** Confirmed
   exactly as reported, by reproduction: see the `realpath()` bullet above.
   Fixed in this version; a regression test (`cli-executors.test.ts`)
   constructs a symlinked workspace root and cwd and asserts the resolved
   real paths appear in `--settings`, not the symlink strings.
4. **AC4 ("cada bloqueio gera evento de auditoria") has no code in the diff
   and no mention in this ADR.** The claim behind the silence was checked,
   not just asserted: `persistStreamEvent`
   (`packages/orchestrator/src/workflow-orchestrator.ts`) already persists
   every `ExecutorStreamEvent` — including a `tool_end` event for a
   sandbox-denied Bash call — into `StepEventRepository`. Reproduced against
   the real `--output-format stream-json` protocol: a sandbox `EPERM` on a
   Bash command produces a `tool_result` block with `is_error: true` and
   `content` limited to the (non-secret) error text, which
   `createClaudeStreamMapper` maps to `{ type: 'tool_end', ok: false, detail:
   <truncated stderr> }`. This *is* a real, already-persisted, per-tool-call
   audit event with no protected content. What it is **not** is part of the
   dedicated `GET /runs/:runId/audit` endpoint
   (`ProjectService.exportRunAudit`), which is scoped to approval
   requests/decisions/feedback only and doesn't read `StepEventRepository`
   at all. Whether that endpoint needs extending to include boundary
   denials is a product decision this ADR doesn't make — flagged to the
   issue owner rather than decided here or silently left as before.
5. **Does `excludedCommands: ["docker *"]` actually still work with
   `allowUnsandboxedCommands: false`, or does the latter override the
   former and break every allowlisted `docker` call?** Verified, not
   assumed: with both settings active together (the exact production
   config), `docker --version` ran successfully, unsandboxed, with an empty
   `permission_denials` list. The two settings are independent —
   `excludedCommands` are recognized up front and never enter the sandbox
   attempt at all, while `allowUnsandboxedCommands: false` only disables the
   *retry* escape hatch for a command that attempted the sandbox and failed.
   No regression; this ADR's original claim holds, now with evidence instead
   of inference.

## Second review round

A second pass on the fixed version raised two further points. Both checked
against reproduction again, not accepted on argument:

- **Two credential files still missing: `~/.config/gh/hosts.yml` (the
  `gh` CLI's plaintext GitHub token, mode `0600`, same host user the
  sandbox runs as) and `~/.git-credentials`.** Confirmed as a real gap —
  `git` is the toolchain entry `MUTATING_BASH_ALLOWLIST` depends on most,
  and `gh`-style credential storage is exactly the shape the rest of
  `DENIED_CREDENTIAL_FILES` already covers. Both added.
- **Which entry actually produced each `EPERM` — is `~` in
  `credentials.files` actually expanding, or is a `~`-form entry a silent
  no-op the same way an unresolved symlink was?** A fair question given
  #3's bug was exactly a silent, non-erroring mismatch — the earlier "it
  returned EPERM" evidence didn't by itself rule out that some *other* deny
  entry (e.g. `denyRead: [tmpdir()]`) was what actually matched. Re-verified
  with an isolated reproduction designed to make this unambiguous:
  `denyRead` pointed only at an empty, unrelated directory (nothing under
  `$HOME` or the OS temp root), and `credentials.files` carried a single
  `~/<bait-dir>/settings.json` entry. Two independent signals confirmed the
  tilde form resolved correctly: (1) Claude Code's own system context, which
  the model reads and quotes back, showed the *fully expanded* absolute
  path merged into its resolved `denyOnly` list — direct evidence from the
  CLI's own policy resolution, not inferred from behavior; (2) with the
  bash/node escape framing that worked in the first round, the same read
  attempt against a `credentials.files`-only entry (no overlapping
  `denyRead`) failed the same way. Also observed, worth recording:
  `credentials.files`-listed paths triggered the model's own self-refusal
  (reading its exposed sandbox policy and declining before even calling a
  tool) far more reliably than a plain `filesystem.denyRead` entry did —
  Claude Code appears to flag credential-labeled paths more assertively to
  the model itself. That's a second, independent layer above the OS
  boundary, not a replacement for it; the `credentials.files` deny still
  fires at the OS level regardless of whether the model tries.
- **The ADR's list is a named deny list, not an allowlist.** Made explicit
  in the code comment and here: everything under `$HOME` outside
  `filesystem.denyRead` and `DENIED_CREDENTIAL_FILES` — `~/.kube`,
  `~/.gnupg`, `~/Documents`, anything not named — stays readable. This is
  the same, already-accepted tradeoff as rejecting `denyRead: ["/"]`
  (broad denial breaks the toolchain); it is a known ceiling, not an
  oversight, and is recorded here so nobody who extends this list later
  mistakes it for exhaustive coverage.
- **AC4's "smallest marker," with the real payload.** Captured a real
  `claude` CLI run against the live sandbox and fed the actual `tool_use`/
  `tool_result` pair through the real `createClaudeStreamMapper` — not a
  synthesized example. A Bash-tool OS-sandbox `EPERM` produces:

  ```json
  {
    "type": "tool_end",
    "toolName": "Bash",
    "summary": "Bash failed",
    "ok": false,
    "detail": "Exit code 1\nnode:fs:440\n...\nError: EPERM: operation not permitted, open '/tmp/fw-audit/data/README.md'\n..."
  }
  ```

  and a Read-tool permission-ask denial (the pre-existing, non-sandbox
  boundary — outside-cwd reads via the Read tool, covered before #565)
  produces:

  ```json
  {
    "type": "tool_end",
    "toolName": "Read",
    "summary": "Read failed",
    "ok": false,
    "detail": "Claude requested permissions to read from /tmp/fw-audit/data/README.md, but you haven't granted it yet."
  }
  ```

  Both `detail` strings carry a substring an ordinary tool failure (a
  typo'd command, a dropped network connection) does not: `"EPERM:
  operation not permitted"` for the OS-sandbox path, `"requested
  permissions to read from"` for the permission-ask path. Pinned as a
  regression test in `claude-stream-events.test.ts` — routed through the
  real `createClaudeStreamMapper`, not asserted on a bare literal, so the
  test actually fails if the mapper's output ever changed — using this
  exact captured payload, per the request: an assertion, zero production
  code. `persistStreamEvent` already stores this `detail` text verbatim in
  `StepEventRepository`.

  **Scope of this evidence, stated precisely rather than implied:** both
  payloads above were captured on macOS, where the sandbox backend is
  Seatbelt. The error text a denial produces is a property of the
  enforcing mechanism, not of the `sandbox.filesystem` policy — a different
  backend can reasonably deny access through a different code path with
  different wording. This ADR has evidence that bubblewrap (the Linux/WSL2
  backend, the actual deployment target) *starts* inside this repo's
  container with `security_opt: seccomp:unconfined` (see Consequences), but
  **no evidence of what text a bubblewrap-enforced denial produces** — that
  reproduction needs a real `claude` session running under Linux/bubblewrap,
  which needs its own provider credential and wasn't available in this
  session. Until captured, treat "query `StepEventRepository` for `EPERM:
  operation not permitted`" as verified on Seatbelt/macOS only. If
  bubblewrap's denial text differs, that query silently returns zero
  matches on Linux — no error, just an undercount — without this line
  being wrong anywhere a reader would notice. Low stakes today only because
  this ADR's own Consequences section already notes the sandbox settings
  are inert in the checked-in reference deployment (`EXECUTOR_MODE=mock`,
  no CLI binaries installed); it stops being low stakes the moment a real
  deployment flips that on.

  One more precision worth recording: `"EPERM: operation not permitted"` is
  a standard OS errno string, not a sandbox-specific one — an unrelated
  permission error (e.g. a genuinely unreadable file due to Unix
  permissions, nothing to do with the sandbox) would produce the same text.
  This substring answers "did some boundary deny something in this run?",
  not "give me an exact count of sandbox denials" — good enough for AC4's
  audit-event requirement, not precise enough for a dashboard metric.

## Third review round: the temp-directory fix broke the toolchain it was meant to protect

After #638 merged, a review of `denyRead`'s temp-directory coverage (added
in the first round to close AC5) found a defect in the fix itself, not a
new gap.

**The defect.** `safe-env-allowlist.json` passes `TMPDIR`/`TEMP`/`TMP`
through from the host to the spawned `claude` process (`safeSpawnEnv`), so
every toolchain command the Bash tool runs — `pnpm`, `git`, `node` — reads
and writes through the *same* directory `denyRead` had just been pointed
at. Writing there was still allowed (the sandbox's own default write
range); reading it back was not. Any tool that round-trips through
`$TMPDIR` — stage a file, read it back — breaks, silently, only in
`EXECUTOR_MODE=real` (the one mode nothing in this repo's CI or reference
deployment exercises, so nothing caught it before review). ADR-0076's own
filesystem clause names the fix directly: *"the assigned worktree, an
**ephemeral temporary directory**, and scoped provider-authentication
capabilities"* — an exposed ephemeral temp dir, not a denied shared one.

**First attempt at a fix, and why it was wrong.** The obvious fix — a
per-run temp directory *inside* `cwd`, covered by the existing `allowRead`
entry, no new sandbox setting needed — was rejected before being written.
`FileWorkspaceManager.checkpoint`/`commit`/`preserveDraft`/`ensureGit` all
run `git add -A` against the workspace (`workspace-manager.ts:218,239,268,315`).
A temp file inside `cwd` gets staged on the very next checkpoint and, via
`integrateWorktree`, merged into the primary — landing in the *generated
app's own git history*. This is not hypothetical: the repo already paid
for exactly this mistake once, with a shared `node_modules` symlink
untracked instead of ignored (`workspace-manager.ts`,
`#excludeNodeModules`'s doc comment: *"`checkpoint`'s `git add -A` stages
it, commits it onto `af/task/<label>` on the very first checkpoint after a
fork, and `integrateWorktree` merges it into the primary"*).

**The actual fix.** `ClaudeCliExecutor.invocation()` now creates a per-run
temp directory as a sibling of `projects/`, not inside any worktree:
`mkdtemp(<workspaceRoot>/.agent-foundry-run-tmp/run-)`. It gets its own
narrower `allowRead` entry (re-opened inside the wider `denyRead` on
`workspaceRoot`, same mechanism as `cwd`'s own entry) rather than being
folded into `cwd`'s. `TMPDIR`/`TEMP`/`TMP` in the invocation's
`environment` are overridden to point at it, taking precedence over the
host-inherited values (`safeSpawnEnv`: `{ ...pickSafeEnvironment(source),
...overrides }`, overrides spread last). Verified against the real CLI,
using the actual generated `--settings`/environment (not a hand-built
approximation): a `node -e` round-trip through `$TMPDIR` now succeeds
end-to-end, and a real `git init && git add -A` in `cwd` afterward shows
nothing from the temp directory in `git status --porcelain` or `git diff
--cached --name-only`. A sibling run's temp directory under the same
`.agent-foundry-run-tmp/` parent is confirmed excluded from `allowRead` —
per-run isolation holds; this isn't a blanket re-opening of the whole
scratch area.

**The `outputDirectoryRoot` guard.** `BaseCliExecutor`'s existing cleanup
(`rm(invocation.outputDirectory, { force: true, recursive: true })` in
`execute()`'s `finally`) is reused for this new temp directory — the
field's only real contract, from its one prior user (Codex's
`--output-last-message` directory), was already "ephemeral, owned by this
invocation, remove after." Reusing it is free. But `force: true` never
warns on a wrong path, and this temp directory is now nested under a
longer-lived root (the Foundry Data Directory) rather than built from a
single fixed `mkdtemp` call the way Codex's is — a real, if narrow,
path-confusion risk for a future bug. `CliInvocation` gained an optional
`outputDirectoryRoot`; when set, `execute()` verifies containment (reusing
`resolveWorkspaceRelativePath`, the same containment check the sandbox
settings themselves use) immediately before the recursive delete, and
refuses — logging instead of deleting — if `outputDirectory` resolves
outside it. `ClaudeCliExecutor` sets it to `workspaceRoot`; Codex's own
`outputDirectory` is left as before, since a value built from a single
`mkdtemp(tmpdir(), 'agent-foundry-codex-output-')` call has no realistic
path-confusion surface to guard against. (Codex will want both an output
directory and this same per-run temp-dir treatment once #637 closes its
own read-boundary gap — noted for that issue, not resolved here.)

## Consequences

- **Positive:** a model-invoked Bash tool call — including through any of
  the eight allowlisted binaries, via path traversal, an absolute path, or a
  symlink — can no longer read outside this run's own workspace on macOS,
  **measured** directly (every reproduction in this ADR ran on macOS/
  Seatbelt). The same holds on Linux/WSL2 (bubblewrap) as a reasonable but
  **unmeasured** inference — same `sandbox.filesystem`/`credentials.files`
  JSON policy, same vendor-documented enforcement — not yet reproduced on
  that backend (see the AC4 marker scope note above for exactly what's
  missing and why it matters more once a real deployment turns this on).
  This closes ADR-0063's named residual risk for the Claude executor
  specifically, on the platform this ADR actually exercised.
- **Negative — Codex is not fixed by this ADR.** Codex's own sandbox has no
  read-restriction primitive (confirmed against its policy schema, not
  guessed). The `node -e readFileSync(...)` reproduction in Context still
  succeeds unmodified against `codex exec --sandbox workspace-write` after
  this change. Closing it needs wrapping the Codex subprocess in an external
  OS-level jail — the same class of work rejected above as out of scope for
  a configuration-only fix. **Filed as a follow-up issue, not silently
  deferred** — #637.
- **Negative — `docker` stays fully unconfined for anyone who can reach the
  allowlist.** Accepted risk, not overlooked: in the containerized
  deployment (`docker-compose.yml`), the `api`/`worker` services have no
  `docker.sock` mounted, so `docker` calls fail outright regardless of
  sandboxing. In the "trusted, local-development fallback" mode
  (`local-execution-plane.ts`'s own docstring), the operator's own machine
  is already the trust boundary, and full docker access was already
  available and accepted before this change. If a deployment topology
  changes this (e.g. docker-in-docker with a mounted socket), that
  deployment needs its own review — this ADR does not cover it.
- **Operational — deployment must provide the sandbox's dependencies.**
  `failIfUnavailable: true` means a Claude run in `EXECUTOR_MODE=real`
  simply cannot start without `bubblewrap` and `socat` present (Linux/WSL2)
  or Seatbelt (macOS, built in). The Dockerfile now installs both. **Also
  verified empirically against this repo's own `Dockerfile`:** bubblewrap
  cannot create the unprivileged user namespace it needs inside an
  unprivileged container at all — `bwrap: No permissions to create new
  namespace` — under Docker's default seccomp profile. `--security-opt
  seccomp=unconfined` on the outer container was confirmed to fix it (a
  narrower `--cap-add=SYS_ADMIN` alone was not enough — it got past
  namespace creation but failed at `pivot_root: Operation not permitted`).
  `docker-compose.yml`'s `worker` service now sets `security_opt:
  [seccomp:unconfined]`. This is a real, disclosed trade-off: it widens the
  outer container's own syscall filter to enable the sandbox that then
  narrows what the model's tools can reach inside it. Any other production
  topology (Kubernetes, a different container runtime) needs the equivalent
  of this same relaxation before flipping `EXECUTOR_MODE=real`, or Claude
  runs will fail to start at all.
- **Not addressed by this ADR:** installing the `claude`/`codex` CLI
  binaries themselves into the deployment image — `EXECUTOR_MODE=real` does
  not work against the checked-in `Dockerfile` today for reasons unrelated
  to this change (the binaries aren't installed), and today's
  `docker-compose.yml` defaults every service to `EXECUTOR_MODE=mock`, so
  this ADR's sandbox settings are inert in that reference deployment as
  shipped. It becomes load-bearing the moment a deployment switches to real
  execution.

## Validation and rollback

Exact-argv unit tests in `packages/executors/src/cli-executors.test.ts`
assert the `--settings` JSON's `sandbox.enabled`, `failIfUnavailable`,
`allowUnsandboxedCommands`, `filesystem.denyRead` (workspace root + tmpdir)/
`allowRead` (`cwd` plus this run's own temp directory, both scoped
per-request, not a fixed path), `credentials.files`, `network.allowedDomains`,
and `excludedCommands`, for both mutating and read-only runs — plus a
dedicated regression test that constructs a symlinked workspace root and cwd
and asserts `--settings` carries the `realpath()`-resolved forms, not the
symlink strings. A separate test creates a real git repository at `cwd`,
writes into the run's temp directory the way a toolchain command would,
stages the workspace with `git add -A`, and asserts nothing from the temp
directory appears in `git status --porcelain` or the staged diff — the
regression test for the third review round. `BaseCliExecutor`'s
`outputDirectoryRoot` guard has its own unit tests in
`base-cli-executor.test.ts`: cleans up normally when `outputDirectory`
resolves inside the declared root, refuses (and logs, verified via a
`console.error` spy) when it resolves outside, and is a no-op — unchanged
Codex behavior — when no root is declared at all. Symlink/traversal
containment for `readWorkspaceFile` is covered in
`packages/persistence/src/workspace-manager.test.ts`. The live-CLI
reproductions in Context and in the three review-round sections (Read-tool
default denial, the Bash/node escape before and after this change, the
network default-deny, the container bubblewrap failure and its
`security_opt` fix, the credential/tmpdir gap and its fix, the symlinked-
`workspaceRoot` bypass and its fix, the `tool_end`/`is_error` audit-event
evidence, the `excludedCommands` vs `allowUnsandboxedCommands` independence,
and the `$TMPDIR` round-trip through the real generated `--settings`/
environment) were run against the real `claude`/`codex` CLIs and this
repo's real `Dockerfile`, not asserted from documentation — this ADR is the
record of that evidence; there is no automated CI job that re-runs them
(real-CLI runs need network + provider auth CI does not have, matching
ADR-0063's own precedent of verifying empirically and pinning the result in
unit tests rather than a live CI call).

To roll back: drop the `--settings` push in `ClaudeCliExecutor.invocation()`
and the `workspaceRoot` constructor parameter; Claude runs return to
ADR-0063's allowlist-only state. The `Dockerfile`/`docker-compose.yml`
changes are additive and harmless to leave in place independently.
