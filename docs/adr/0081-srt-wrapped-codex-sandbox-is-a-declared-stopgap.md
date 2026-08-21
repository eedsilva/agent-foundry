# ADR 0081: srt-wrapped Codex sandbox closes the filesystem gap as a declared stopgap, not ADR-0076 compliance

- Status: Accepted
- Date: 2026-08-21
- Owners: Security
- Tracked by issue #637 (parent #565; sibling of ADR-0071)

## Context

ADR-0071 closed #565 for the Claude executor and named Codex's identical gap
explicitly as a follow-up: Codex's own `SandboxPolicy`
(`codex-rs/app-server-protocol/schema/typescript/v2/SandboxPolicy.ts`) has
exactly four variants — `dangerFullAccess`, `readOnly`, `externalSandbox`,
`workspaceWrite` — and `workspaceWrite`'s own fields (`writable_roots`,
`network_access`, `exclude_tmpdir_env_var`, `exclude_slash_tmp`) contain no
read-path restriction anywhere. Reproduced against the real
`codex exec --sandbox workspace-write` argv `CodexCliExecutor` builds: the
prompt `run node -e "console.log(require('fs').readFileSync('<path outside
the workspace>','utf8'))"` executes and returns the file's contents, exit
code 0 — no denial. Unlike Claude, there is no `--settings`-equivalent
capability already in the CLI to turn on; closing this needs an **external**
OS-level jail wrapped around the whole Codex process.

**Scope, set before any code was written.** #637 is filesystem confinement
via `@anthropic-ai/sandbox-runtime` (`srt`) plus the minimal network
allowlist `srt` itself requires to start — not full ADR-0076 compliance.
Doc-pinned origins, a DNS/HTTP audited proxy, and exact per-port loopback
scoping are explicitly out of scope; #637 must document what it does not
provide, not claim containment it doesn't have. Three gate measurements were
required with real evidence before design started, recorded here rather than
re-derived:

**Gate 1 — `github.com`/`developers.openai.com` are safe to exclude.** A real
logging CONNECT proxy blocked both hosts with a genuine 403. A full mutating
task (create `hello.txt`, run `npm --version` via Bash) completed with
`turn.completed` success and correct output on both steps. Both hosts were
observed in live Codex traffic but are not part of ADR-0076's own enumerated
allowlist (auth/inference endpoints + `registry.npmjs.org`); confirmed
non-essential, excluded.

**Gate 2 — loopback is in the critical path, not port-scopable.** A real
DB-form implementation task had Codex write and run a Node script opening a
raw TCP connection to a real local Postgres (Docker container, port 54322 —
the Local Supabase convention). Without any loopback allowlist entry, this
failed closed: `ERROR connect EPERM 127.0.0.1:54322`. Isolated, not guessed:
`allowedDomains: ["127.0.0.1"]` alone still produced `EPERM`;
`+ allowLocalBinding: true` connected. `NO_PROXY`/`no_proxy` were tested and
found unnecessary for this path — Node's `net.connect` never reads them; that
variable only matters for HTTP-aware clients (`curl`, `fetch`), not raw
socket protocols like Postgres wire protocol. **A second, independent
finding surfaced in the same measurement:** the `:port` suffix on an
`allowedDomains` entry (`127.0.0.1:54322`) does **not** restrict the port
once `allowLocalBinding: true` is set — a second listener on a different,
non-allowlisted port was still reachable. `allowLocalBinding: true` opens
loopback wholesale in this srt version, not the exact port named. This
directly contradicts ADR-0076's "exact loopback... services" language at the
mechanism's actual implementation level — the ADR asks for a granularity
`srt`, as measured, does not deliver.

**Gate 3 — the real minimal auth carve-out for Codex.** First attempt failed
with `Error: failed to initialize in-process app-server client: Operation not
permitted`. Root cause found with `/usr/bin/log stream --predicate 'sender ==
"Sandbox"'` (not the bare `log` command — zsh has a builtin `log` that
silently swallows `log stream` with no output and no error, a trap worth
naming so nobody re-spends the time on it): the test's own `settings.json`
was built through a heredoc where `$HOME` expanded at file-creation time to
the real user's home directory, not the redirected `$HOME` the child process
actually ran under — a shell interpolation bug in the test harness, not a
Codex or srt defect. Fixed by writing the redirected path as a literal
string instead of an interpolated `$HOME`; the error disappeared entirely,
and Codex authenticated and completed a real task. **The measured carve-out:**
`~/.codex/auth.json` (read) is enough for the token, but a trivial Codex call
writes broadly across `~/.codex/`: sqlite state (`memories`, `queue`, `logs`,
`goals`, `state`), `installation_id`, `models_cache.json`,
`mcp-oauth-locks`, an `apps_server_info` cache, and in one run downloaded a
marketplace plugin into `.tmp/marketplaces/`. The working carve-out is
"`auth.json` read + write access to all of `~/.codex`," measurably broader
than ADR-0076's own wording, "scoped provider-authentication capability."
The same successful run logged extensive but tolerated denials —
`mach-lookup` to `com.apple.diagnosticd`/`SystemConfiguration.configd`/
`analyticsd`/`trustd.agent`, and direct `network-outbound` attempts outside
the proxy — system telemetry/network probes Codex treats as non-fatal, not a
boundary failure.

## Decision

Wrap the entire Codex CLI process — not just a subset of its tool calls — in
`srt` (`@anthropic-ai/sandbox-runtime`, the same Seatbelt/bubblewrap
primitive Claude Code's own sandbox uses, packaged as a standalone process
wrapper). `CodexCliExecutor.invocation()` now returns `command: 'srt'` with
`codex exec ...` as the wrapped command after a `--` separator, driven by a
per-run settings file (`srt` takes a file path, not inline JSON like Claude
Code's `--settings`):

```json
{
  "filesystem": {
    "denyRead": ["<realpath(workspaceRoot)>", "<realpath(tmpdir())>", "<credential paths>"],
    "allowRead": ["<realpath(cwd)>", "<realpath(runTempDir)>"],
    "allowWrite": ["<realpath(cwd)>", "<realpath(runTempDir)>", "<realpath(~/.codex)>"],
    "denyWrite": []
  },
  "network": {
    "allowedDomains": [
      "chatgpt.com", "ab.chatgpt.com", "api.openai.com", "registry.npmjs.org",
      "127.0.0.1", "localhost"
    ],
    "deniedDomains": [],
    "allowLocalBinding": true
  }
}
```

- **`denyRead`/credential list mirror `claude-executor.ts` exactly** — the
  shared workspaces root, the OS temp root, and the same
  `DENIED_CREDENTIAL_RELATIVE_PATHS` list ADR-0071 built up over two review
  rounds (`.ssh`, `.aws/credentials`, `.claude/.credentials.json`, `.netrc`,
  `.docker/config.json`, `.npmrc`, `.git-credentials`,
  `.config/gh/hosts.yml`). `srt` has no separate `credentials.files` block
  like Claude Code's sandbox does, so these land in the one `denyRead` array
  instead. `~/.codex` needs no explicit `allowRead` entry — `srt`'s read
  default is allow-everywhere-except-`denyRead`, and nothing above denies
  it.
- **`allowWrite` needs `~/.codex` explicitly** — `srt`'s write policy is
  deny-by-default (the opposite convention emphasis from its read policy).
  Unlike Claude Code's sandbox, which only wraps the Bash tool and leaves the
  `claude` process itself unsandboxed, `srt` wraps the Codex process that
  owns its own authentication — this carve-out is what makes Codex able to
  authenticate and run at all, not an incidental grant. Sized to Gate 3's
  measured carve-out (`auth.json` + broad `~/.codex` write), not to the
  narrower "scoped provider-authentication capability" ADR-0076's text
  suggests — that gap between the two is a **named deviation**, not an
  oversight (see "Non-conformance with ADR-0076" below).
- **`network.allowedDomains` is a static list copied from ADR-0076's own
  enumeration** ("the selected model provider's authentication and inference
  endpoints" + "the public `registry.npmjs.org`"), not independently chosen.
  Both `chatgpt.com`/`ab.chatgpt.com` and `api.openai.com` are listed because
  nothing in this repo picks between them — the operator's own `codex login`
  state decides which endpoint is actually used, and this repo's
  `safe-env-allowlist.json` carries no `OPENAI_API_KEY` or similar that would
  let code choose. `github.com`/`developers.openai.com`, observed in live
  traffic, are deliberately excluded per Gate 1.
- **`127.0.0.1`/`localhost` + `allowLocalBinding: true`, loopback fully
  open, not port-scoped** — per Gate 2, this is the only version of loopback
  access `srt` was measured to actually enforce; a port suffix is
  cosmetic under `allowLocalBinding`. This is a **named residual risk**, not
  a silent gap (see below).
- **`-d` (debug mode) is required, not cosmetic.** It's the only channel
  `srt` gives for the network-boundary audit trail: without it, a denial
  reaches the model as an opaque "fetch failed" with no host, and nothing
  else in this run has any record of what was blocked. `BaseCliExecutor`
  gained a new protected hook, `auditStderr(stderr, request)`, called once
  per invocation after the process exits (no-op by default; Claude's own
  sandbox already surfaces a denial inline in the tool's own stdout/stderr,
  so it needs no override). `CodexCliExecutor` overrides it to parse
  `\[SandboxDebug\] Connection blocked to (\S+)` out of `srt`'s debug stderr
  and log only the matched host plus the run's role —
  never the raw `stderr`, which also carries the wrapped command's own echoed
  argv and output. Covered by two unit tests: one asserts the host+role
  message and that neither an unrelated stderr line nor the echoed command
  string reaches `console.error`; the other asserts no call happens at all
  when no denial is present.
- **`workspaceRoot` is threaded through the constructor** exactly like
  `ClaudeCliExecutor`: production wiring (`runtime.ts`) passes
  `config.dataDir`; `provider-canary.ts` passes `tmpdir()`, matching how its
  fixture workspaces are `mkdtemp`'d directly under the OS temp dir.
- **Same realpath + symlink-equality-check pattern as ADR-0071's third
  review round**, copied rather than re-derived: `workspaceRoot`/`cwd`/
  `tmpdir()` are all `realpath()`-resolved before being written into the
  settings file (a symlink written literally silently fails to match
  anything in `srt`'s policy, the identical bug class ADR-0071 found), and
  `.agent-foundry-run-tmp` is checked for equality against its own
  `realpath()` before use, refusing rather than silently following a
  redirect. Two regression tests mirror ADR-0071's Claude-side pair exactly,
  scoped to Codex: a symlinked `workspaceRoot`/`cwd` resolves to real paths
  in the settings file, and a symlinked `.agent-foundry-run-tmp` throws
  rather than silently redirecting the run's whole sandbox root. The second
  was verified to actually catch the regression it claims to: with the
  equality check removed, the test failed red (`outputDirectory`,
  `outputDirectoryRoot`, and the settings file itself all silently resolved
  inside the symlink target, no error) before being restored to green.
- **`outputDirectoryRoot: runTempRoot`** (the narrow `.agent-foundry-run-tmp`
  subdirectory, not `workspaceRoot`) is passed to `BaseCliExecutor`'s
  existing cleanup-containment guard from ADR-0071's third review round —
  the same guard, reused as-is, no new logic needed on the base class beyond
  the `auditStderr` hook.
- **The native `--sandbox workspace-write`/`read-only` flag is kept**,
  nested inside the `srt` wrapper, not replaced. Verified the two nest
  without conflict — `srt` confines the process at the OS level; Codex's own
  flag additionally restricts writes within what `srt` already permits. No
  reason found to drop either layer.

## Non-conformance with ADR-0076, stated explicitly

This ships as a declared stopgap. It must not be read as satisfying
ADR-0076, and each specific gap is named here rather than left implicit:

- **No enforced proxy, no audited DNS/HTTP layer.** ADR-0076 requires
  implementation to "restore an enforcing boundary based on ADR-0028's
  internal-network plus audited DNS/HTTP proxy design, or another backend
  that passes equivalent escape tests." `srt`'s static `allowedDomains` is
  neither — it is a coarser, unaudited, non-DNS-aware allowlist. This is the
  entire point of scoping #637 to filesystem confinement plus the minimal
  network price `srt` charges to start, not network policy in the ADR-0076
  sense.
- **No doc-pinned origins.** ADR-0076 calls for "exact official
  documentation origins pinned by the scaffold and explicitly enabled for
  the task." No such mechanism exists yet anywhere in this repo; #637 does
  not add one.
- **Loopback ships fully open, not "exact... services."** Per Gate 2, this
  is not a choice — it's the ceiling of what `allowLocalBinding: true` was
  measured to enforce in this `srt` version. Accepted as a residual risk
  because loopback is genuinely in the critical path (DB-form
  implementation tasks touch local Supabase/Postgres) and the alternative —
  shipping without any loopback access — breaks that class of task outright.
  **With loopback fully open, the sandboxed Codex process can also reach
  this repo's own control-plane API**, which has no authenticated local
  session on `main` yet. #637 does not fix that exposure — #597 does. This
  is not a regression #637 introduces: Codex already has unrestricted
  network access today, so an unauthenticated control-plane endpoint
  reachable from a Codex-spawned process is not new risk #637 creates, but
  it is risk #637 also does not close, and it should not be read as closed
  by this ADR.
- **The auth carve-out is wider than "scoped provider-authentication
  capability."** Per Gate 3, the measured working carve-out is `auth.json`
  read plus broad write access to `~/.codex` (sqlite state, caches,
  installation ID, and observed marketplace-plugin downloads) — not a single
  scoped token file. ADR-0076's text should be read as describing the goal,
  not what this stopgap delivers.
- **Package/dependency installation controls (pinned lockfile enforcement,
  registry-redirect blocking, disallowed dependency types) are untouched.**
  #637 is a filesystem/process boundary around Codex's own execution, not
  the dependency-installation policy ADR-0076 also describes.

None of this is silent: every gap above was a condition Mansur set before
design started ("#637 já é stopgap declarado não-conforme à 0076; o que ela
não pode fazer é alegar contenção que não tem"), not a shortcut discovered
after the fact.

## Alternatives considered

- **Full ADR-0076 compliance now (ADR-0028's proxy design).** Rejected for
  this issue, not rejected outright — a materially larger effort (an
  internal network, an audited DNS/HTTP proxy or equivalent sidecar, its own
  regression surface) that #637 was explicitly scoped away from. Tracked as
  still-open work under ADR-0076, not resolved here.
- **`DockerSandboxRunner` (this repo's existing full-container isolation,
  currently used only for preview installs).** Considered and rejected —
  **not** because ADR-0076 forbids it (an earlier framing of this rejection
  was itself corrected during scoping), but because it needs `docker.sock`
  mounted on the worker, a cost/infra risk change bigger than this issue's
  scope, and because the containerized deployment's `worker` service
  deliberately has no `docker.sock` mounted today (see ADR-0071's
  Consequences on `docker` staying unconfined for the same reason).
- **Port-scoped loopback instead of fully open.** Attempted and rejected —
  not a design choice but a measured `srt` limitation (Gate 2): the `:port`
  suffix does not restrict access once `allowLocalBinding: true` is set.
  Achieving real port-exactness needs a different enforcement mechanism than
  `srt` provides today, out of scope for this stopgap.
- **A narrower `~/.codex` carve-out (e.g. `auth.json` alone).** Attempted
  implicitly by starting from the narrowest plausible grant and rejected by
  measurement (Gate 3) — Codex fails to initialize with anything less than
  broad `~/.codex` write access.

## Related, unresolved tension (not decided here)

ADR-0028's own `ExecutionNetworkPolicy` allowlist syntax rejects `localhost`/
IP literals, while ADR-0076 explicitly requires loopback services be
allowlisted for Local Supabase. That is a real conflict between two accepted
ADRs, surfaced during #637's scoping discussion, not introduced by this
change and not resolved by it — flagged to the issue owner (Ed) as a
decision the eventual ADR-0076-compliant implementation will have to make,
not something #637 works around in code.

## Consequences

- **Positive:** a Bash/shell command running under `CodexCliExecutor` —
  through path traversal, an absolute path, or a symlink — can no longer
  read outside this run's own workspace on macOS, **measured** directly
  (every reproduction in this ADR ran on macOS/Seatbelt, same scope
  disclaimer as ADR-0071). The same is expected on Linux/bubblewrap as a
  reasonable but **unmeasured** inference (`srt` documents wrapping the same
  Seatbelt/bubblewrap primitives Claude Code's sandbox uses) — not yet
  reproduced on that backend. This closes #637's acceptance criteria and, by
  extension, the last gap ADR-0071 named as unclosed for #565.
- **Negative — this is not ADR-0076 compliance**, per "Non-conformance with
  ADR-0076" above. It must not be cited as closing ADR-0076's own Validation
  criteria (the escape-test list: direct IP, alternate DNS, redirects,
  WebSocket, raw sockets, private ranges, metadata addresses, undeclared
  loopback ports).
- **Negative — loopback fully open compounds with #597's unauthenticated
  control session** until #597 ships. Named explicitly rather than left as
  an implicit side effect of the loopback decision.
- **Operational — `srt` is not installed in this repo's `Dockerfile`,**
  matching the existing convention for `claude`/`codex` themselves: all
  three are expected to already be on the host/image PATH wherever
  `EXECUTOR_MODE=real` actually runs, which today is the local fallback only
  (see ADR-0071's Consequences — the reference `docker-compose.yml` defaults
  every service to `EXECUTOR_MODE=mock`, so this ADR's settings are inert in
  that deployment as shipped). The `Dockerfile`'s existing `bubblewrap`/
  `socat` install (added for #565) is documented as also serving `srt` on
  Linux, per `srt`'s own documented use of the same primitive — not
  independently verified on Linux in this session.
- **Not addressed by this ADR:** process-tree/cancellation behavior when
  `srt` wraps `codex` — `execa`'s `detached: true` process-group termination
  was not specifically re-verified against the added `srt` layer in this
  change. No evidence of a problem; also no dedicated test added for it.
  Worth a follow-up check before `EXECUTOR_MODE=real` sees production
  traffic with cancellation in the loop.

## Validation and rollback

`packages/executors/src/cli-executors.test.ts` asserts, against the real
argv/settings-file shape `CodexCliExecutor` builds: `command: 'srt'` with
`-d -s <path> -- codex exec ...`; the settings file's `filesystem.denyRead`
(workspace root, tmpdir, and the full credential-path list, including
spot-checks for `.ssh` and `.git-credentials`), `allowRead`/`allowWrite`
(`cwd` plus the run's own temp dir), and the `~/.codex` write carve-out;
`network.allowedDomains` (the static list plus `127.0.0.1`/`localhost`),
`allowLocalBinding: true`, and the explicit absence of `github.com`/
`developers.openai.com`; a symlinked `workspaceRoot`/`cwd` resolving to real
paths, not symlink strings; a symlinked `.agent-foundry-run-tmp` throwing
rather than silently redirecting (reverted locally and confirmed to fail red
before being restored, per ADR-0071's own precedent); and `auditStderr`
extracting exactly host+role from a `[SandboxDebug] Connection blocked to`
line, never leaking the raw stderr, plus a no-op case when no denial line is
present. A fake `srt` binary
(`packages/executors/src/fixtures/fake-cli/srt`) strips `srt`'s own flags
and execs the wrapped command directly, so
`packages/executors/src/fake-cli.integration.test.ts` and
`packages/composition/src/ui-quality-judge.integration.test.ts` exercise the
exact production argv shape end-to-end (both suites green) without needing
real bubblewrap/Seatbelt/`srt` installed in CI — matching how the existing
fake `claude`/`codex` fixtures already worked before this change.

All three gate-measurement reproductions (Gates 1–3 above) were run against
the real `srt`/`codex` binaries on macOS/Seatbelt with real network proxying
and a real local Postgres, not asserted from `srt`'s documentation — recorded
in issue #637's own comment thread as the primary evidence; this ADR
restates it for the permanent record. As with ADR-0071, there is no CI job
that re-runs these live reproductions (real-CLI runs need network + provider
auth CI does not have); the unit/integration tests above pin the resulting
behavior against the fake CLI fixtures instead.

To roll back: drop the `srt` wrap in `CodexCliExecutor.invocation()`,
restore `command: 'codex'` with the same `codex exec` args currently placed
after the `--` separator, drop the `workspaceRoot` constructor parameter,
and remove the `auditStderr` hook from `BaseCliExecutor` (unused once no
executor overrides it). Codex runs return to the pre-#637 state: `--sandbox
workspace-write` only, no read boundary, no network allowlist, exactly
ADR-0071's documented residual gap.
