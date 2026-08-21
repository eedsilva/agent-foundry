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
    "filesystem": { "denyRead": ["<workspaceRoot>"], "allowRead": ["<request.cwd>"] },
    "network": { "allowedDomains": ["*"] },
    "excludedCommands": ["docker *"]
  }
}
```

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

## Consequences

- **Positive:** a model-invoked Bash tool call — including through any of
  the eight allowlisted binaries, via path traversal, an absolute path, or a
  symlink — can no longer read outside this run's own workspace on Linux,
  WSL2, or macOS with the sandbox available. This closes ADR-0063's named
  residual risk for the Claude executor specifically.
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
`allowUnsandboxedCommands`, `filesystem.denyRead`/`allowRead` (scoped
per-request to `cwd`, not a fixed path), `network.allowedDomains`, and
`excludedCommands`, for both mutating and read-only runs. Symlink/traversal
containment for `readWorkspaceFile` is covered in
`packages/persistence/src/workspace-manager.test.ts`. The live-CLI
reproductions in Context (Read-tool default denial, the Bash/node escape
before and after this change, the network default-deny, the container
bubblewrap failure and its `security_opt` fix) were run against the real
`claude`/`codex` CLIs and this repo's real `Dockerfile`, not asserted from
documentation — this ADR is the record of that evidence; there is no
automated CI job that re-runs them (real-CLI runs need network + provider
auth CI does not have, matching ADR-0063's own precedent of verifying
empirically and pinning the result in unit tests rather than a live CI
call).

To roll back: drop the `--settings` push in `ClaudeCliExecutor.invocation()`
and the `workspaceRoot` constructor parameter; Claude runs return to
ADR-0063's allowlist-only state. The `Dockerfile`/`docker-compose.yml`
changes are additive and harmless to leave in place independently.
