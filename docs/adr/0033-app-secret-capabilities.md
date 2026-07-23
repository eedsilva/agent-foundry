# ADR 0033: App secret capabilities via a per-project `.env` file

- Status: Accepted
- Date: 2026-07-23
- Owners: Executors and Orchestrator

## Context

Generated apps often need a real secret to run — a Stripe key, a third-party API token — but the
coding agent that writes the app's code runs as an untrusted local CLI subprocess (`BaseCliExecutor`,
ADR 0001) with no sandboxing yet: `LocalExecutionPlane` (ADR 0023) remains the only agent execution
plane, and `DockerSandboxRunner` (ADR 0025) — the eventual isolated replacement — is not yet wired
into that plane. ADR 0028's migration note is explicit that it "does not claim host credential isolation for
the still-local agent CLI." Before this change, both the coding agent's subprocess and the generated
app's dev-server subprocess (`NodePreviewRunner`, ADR 0018) inherited the control plane's full
`process.env` by default — any environment variable the API/worker process itself had (including its
own credentials — `DATABASE_URL`, `BLOB_SIGNING_SECRET`, provider API keys) was visible to whatever the
agent's CLI or the generated app's dev server chose to read, log, or exfiltrate. Issue #74 asks for a
capability-based mechanism instead: the agent should see only the _names_ of secrets it can reference
in generated code, real values should reach only the process that actually runs the generated app, and
nothing should let a value leak into Git, the compiled prompt, a persisted artifact, an event/log, or a
client bundle.

ADR 0023's `ExecutionRequest.secrets` field already existed as a shape-only placeholder
(`{ name, ref }[]`, always `[]` at the time) for exactly this future work, and ADR 0023 names
`v07-secret-broker` as a separate, dependent roadmap task it explicitly did not deliver. This ADR is
that follow-through, scoped to what Personal v1 actually needs — a local `.env` file and two subprocess
spawn points — not a hosted secret-manager integration.

## Decision

One `.env` file per project, at `<DATA_DIR>/projects/<projectId>/.env` — a sibling of, not inside, the
git-tracked `workspace/` directory (`WorkspaceManager.projectRoot` vs. `workspacePath`,
`packages/persistence/src/workspace-manager.ts`) — so it cannot be committed into the project's own
repo history by construction, and `assertNoRealEnvFilesTracked` (`scripts/lib/secret-scan.mjs`)
backstops the equivalent guarantee for this control-plane repo. `SecretStore`
(`packages/domain/src/ports.ts`) is the port: `names(projectId)` returns the declared capability names
and is safe to expose to the agent's context because it never returns a value; `resolveAll(projectId)`
returns the resolved `KEY=value` map and must only be called from the process that runs the generated
app. `FileSecretStore` (`packages/persistence/src/secret-store.ts`) is the only implementation — it
parses the file with `dotenv`'s `parse` and returns `{}` when the file doesn't exist yet, since "no
secrets declared" is a normal, common state, not an error.

The coding agent and the generated app's dev server are two different subprocesses with two different
trust levels, and only one of them ever sees a real value:

- `WorkflowOrchestrator.executeCandidate` (`packages/orchestrator/src/workflow-orchestrator.ts`)
  populates `ExecutionRequest.secrets` from `SecretStore.names()`, mapped to `{ name, ref: name }` —
  `ref` is a same-value placeholder, not a resolvable reference into anything; nothing dereferences it.
  This is exposure by name only: the agent's compiled prompt can be told `STRIPE_SECRET_KEY` is
  available and generated code can reference `process.env.STRIPE_SECRET_KEY`, but the agent's own CLI
  subprocess (`BaseCliExecutor.executeInvocation`) never calls `resolveAll` and never receives a secret
  value in its `env`.
- `NodePreviewRunner.attemptSpawn` (`packages/executors/src/node-preview-runner.ts`) is the only call
  site that calls `SecretStore.resolveAll(projectId)`, and only at the moment it spawns the generated
  app's dev-server process — the concrete "run the generated app" substrate that exists in Personal v1
  today (see below on VPS/SSH publish). The resolved values go straight into that one subprocess's
  `env` and nowhere else: not into `session.json`, not into preview logs (the log-capture path taps
  stdout/stderr, not the env), not into any artifact.

Both subprocess spawn points stopped inheriting the control plane's full `process.env`.
`pickSafeEnvironment()` (`packages/executors/src/safe-environment.ts`) allowlists only the OS/tooling
variables a spawned child needs to start and find its own config (`PATH`, `HOME`, `LANG`, `TERM`,
`TMPDIR`, `NODE_ENV`, and their Windows equivalents) — never an application secret.
`BaseCliExecutor.executeInvocation` and `NodePreviewRunner.attemptSpawn` both build `env` from
`pickSafeEnvironment()` merged with only what that call site adds explicitly: the CLI's own
`invocation.environment` for the former; `resolveAll()`'s result plus `PORT`/`HOST` for the latter.

That allowlist is necessary but not sufficient on its own. `execa` defaults to `extendEnv: true`, which
re-merges the _entire_ `process.env` underneath whatever `env` object is passed to it — silently
undoing the allowlist for every key the explicit object doesn't already set, and reintroducing exactly
the leak (the control plane's own `DATABASE_URL`, `BLOB_SIGNING_SECRET`, provider keys, and everything
else in its process environment) this change exists to close. Both spawn points now pass
`extendEnv: false` alongside `env` — this is the actual enforcement point, not the allowlist by itself:
`pickSafeEnvironment()` decides what's _in_ the env; `extendEnv: false` is what stops execa from
silently adding everything else back in underneath it. This was found first while implementing
`NodePreviewRunner`'s secret injection, where a real (non-mocked, real `execa`) test spawns the fixture
dev server and hits its `/echo-env` route — that test caught the full `process.env` leaking through
despite `pickSafeEnvironment()` already being applied. The identical defect existed in
`BaseCliExecutor`, but its original test mocked `execa` entirely and so had no way to observe execa's
real merge behavior; the test was strengthened afterward to assert `options.extendEnv === false`
explicitly on the call passed to the mock, since the mock still cannot exercise execa's actual runtime
merge.

`scripts/lib/secret-scan.mjs` backstops the above with a pattern- and exact-value scanner
(`scanForSecrets`, reusing `packages/domain/src/redaction.ts`'s patterns) across three surfaces:
`scanTrackedFiles` (every `git ls-files` entry — source), `scanDirectoryFiles` (the real filesystem
under a given directory regardless of Git — e.g. a Next.js `.next` build, the actual "client bundle"
surface), and `assertNoRealEnvFilesTracked` (fails if any `.env*` other than `.env.example` is
Git-tracked). `scanTrackedFiles` excludes `docs/**`, `examples/**`, and any `*.test.*`/`*.spec.*` path
(`EXCLUDED_TRACKED_PATH`, `scripts/lib/secret-scan.mjs`) — this repo's own test suite deliberately
contains secret-shaped fixtures (e.g. `packages/domain/src/redaction.test.ts`'s `sk-`-shaped strings)
that a pattern-only scanner with no known-value baseline at CI time cannot distinguish from a real leak,
and scanning them unfiltered made the check permanently fail against this repo's own history. This
exclusion is scoped to `scanTrackedFiles` only: `scanDirectoryFiles` and `assertNoRealEnvFilesTracked`
are unaffected and still scan everything, unfiltered. It is a documented, accepted trade-off (see the
`ponytail:` comment at `scripts/lib/secret-scan.mjs:20-28`), not a blind spot the scanner is unaware of
— a real secret accidentally pasted into a test, doc, or example file would not be caught by this
scanner specifically, though it would still be redacted from persisted events by
`redactEvent`/`redactString` (`packages/domain/src/redaction.ts`, ADR 0012) before ever being served
back to a client, and would still fail `assertNoRealEnvFilesTracked` if the file in question were an
actual `.env` file rather than a fixture string embedded in source.

`packages/composition/src/secret-leak.integration.test.ts` is the end-to-end proof: it runs a full mock
workflow against a real per-project `.env`, then asserts the value is absent from every Git-tracked
workspace file, every compiled agent prompt (`REQUEST.md`), every artifact, and every persisted event —
while positively confirming `resolveAll()` does return the real value, since that is the one place it's
supposed to.

VPS/SSH publish (ADR 0008) is not implemented anywhere in this codebase today — `packages/executors`
has no SSH or Compose-deploy code, and `docs/OPERATIONS.md`'s "Deploy em VPS existente" section
describes the target design, not shipped behavior. `NodePreviewRunner`'s dev-server process is
therefore the only concrete "run the generated app" substrate that exists in Personal v1, and the only
place `resolveAll()` is called today. When VPS/SSH publish is built, it must inject secrets by calling
the same `SecretStore.resolveAll()` — writing the resolved values into the deployed app's own `.env` on
the VPS, or passing them to `docker compose` the same way `NodePreviewRunner` passes them to `execa` —
rather than re-deriving a second secret-resolution path. `SecretStore` is deliberately a port for this
reason: a future hosted secret manager becomes a second adapter behind the same port, not a second call
site that has to be kept in sync with this one.

## Alternatives considered

- **Resolve secrets through `ExecutionRequest.secrets[].ref`**, the field ADR 0023 already reserved for
  a future secret broker: rejected for v1. That shape presumes a broker reachable from wherever the
  agent's execution actually runs, which only matters once a remote/sandboxed `ExecutionPlane` exists —
  exactly the work ADR 0023 explicitly deferred. `ref` stays a same-value placeholder (`ref: name`)
  until a real broker gives it independent meaning; adding resolution behind it now would be
  speculative machinery with nothing yet on the other end.
- **Let the agent CLI read `.env` itself** (a convention where the CLI resolves its own environment
  file): rejected. That requires the CLI to have filesystem access to `projectRoot`, which is exactly
  the access this design withholds — the subprocess `env` boundary is the enforcement point precisely
  because it cannot be bypassed by the agent reading a file next to its own workspace.
- **Store secrets inside `workspace/`** (e.g. `workspace/.env`) relying on `.gitignore`: rejected.
  `.gitignore` is a convention the generated app's own code could edit, and the project's own repo
  history is exactly the surface this design must keep a secret out of structurally, not by policy that
  generated code could accidentally or deliberately undo.

## Consequences

The coding agent's compiled prompt and generated code can reference a declared secret name in good
faith (`process.env.STRIPE_SECRET_KEY`) without the agent's own process ever being able to log, commit,
or exfiltrate its value — the value never enters the agent's subprocess environment at all. Operators
manage secrets with a plain text file and no new tooling.

`pickSafeEnvironment()`'s allowlist is small and fixed; if a coding-agent CLI or a generated app's dev
server needs an OS/tooling variable this list doesn't cover, the subprocess fails to start correctly
until the allowlist is extended in code. That is the intended fail-closed behavior — deny by default,
the same posture as ADR 0028's network policy — not a bug to work around at the call site. Secrets
remain file-based and unencrypted at rest: `DATA_DIR` is already a trusted-local boundary for
`session.json` and workspace `.git`, and this ADR adds a per-project `.env` to that same boundary
without changing its scope; protecting `DATA_DIR` itself remains the operator's responsibility (see
`docs/OPERATIONS.md`). `secret-scan.mjs`'s test/doc/example exclusion means a genuine secret pasted
into one of those paths would not be caught by that specific scanner — redaction at the event-append
boundary and the `.env`-tracked guard still apply, but this is a known, accepted gap, not total
coverage, and it should be read as such rather than as a blanket leak guarantee.

## Validation and rollback

`packages/persistence/src/secret-store.test.ts` covers `FileSecretStore` reading a real `.env`, an
absent file, and value parsing. `packages/executors/src/safe-environment.test.ts` covers the allowlist.
`packages/executors/src/base-cli-executor.test.ts` and `node-preview-runner.test.ts` assert
`extendEnv: false` and — for the preview runner, against a real spawned fixture dev server via its
`/echo-env` route — that only allowlisted keys plus resolved secrets reach the child process.
`scripts/lib/secret-scan.test.mjs` covers the scanner's three functions against fixture trees.
`packages/composition/src/secret-leak.integration.test.ts` is the full-stack proof described above.
`npm run secrets:check` runs the scanner in CI against this repo's own tracked files and build output.

Rollback: revert this change set. `SecretStore`/`FileSecretStore` are read-only against an
operator-created file; nothing is written or migrated by this change, so there is no data to unwind.
Reverting restores both subprocesses to inheriting the control plane's full environment — an explicit
regression to the leak this ADR closes — so a partial rollback (for example, reverting
`pickSafeEnvironment`/`extendEnv` while keeping `SecretStore`) must not be done; revert everything in
this set or nothing.
