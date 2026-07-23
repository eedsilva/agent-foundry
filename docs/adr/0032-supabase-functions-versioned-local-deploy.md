# ADR 0032: Versioned local Supabase Functions deploy and rollback

- Status: Accepted
- Date: 2026-07-23
- Owners: Platform, Core
- Extends: ADR 0030

## Context

Issue #69 gives every generated project an isolated Supabase CLI workdir with a local Edge Runtime already enabled (`[edge_runtime]` in `config.toml`). Issue #73 (`v010-functions`) asks for Supabase Functions with immutable, versioned deploys, rollback, declared resource ceilings, and traced invocation — on top of that existing runtime, without Supabase Cloud.

The Supabase CLI has no local equivalent of `supabase functions deploy`: that command targets a linked cloud project. Locally (and in the documented self-hosted Docker setup), a function becomes live purely by existing under `supabase/functions/<name>/` — there is no deploy step to invoke. The CLI's `config.toml` `[functions.<name>]` section only supports `enabled`, `verify_jwt`, `import_map`, `entrypoint`, and `static_files`; it exposes no per-function memory, timeout, or network/egress controls, and the self-hosted Edge Runtime's memory/timeout ceilings (150 MB / 60s by default) are enforced by an orchestrator script we do not control, not per-function.

## Decision

`SupabaseGeneratedProjectRuntime` gains `deployFunction`, `listFunctionVersions`, `rollbackFunction`, and `invokeFunction`. Deploy validates the function's source directory is contained inside the project workdir, snapshots its files (sorted, content-addressed via SHA-256) into an immutable version store under the project's data directory, and activates the version by copying it into the live `supabase/functions/<name>/` directory the CLI's Edge Runtime already serves, writing/updating the `[functions.<name>]` `verify_jwt` field. Rollback re-verifies a stored version's checksum before reactivating it the same way. No CLI subcommand is invoked for deploy or rollback — both are pure filesystem operations, matching how the local runtime actually serves functions.

Deploy and rollback share a single `activateFunctionVersion` step, which — in addition to copying files and updating `verify_jwt` — atomically writes a `current.json` pointer file (`{ versionId }`) to `{dataDir}/projects/{projectId}/functions/<name>/current.json` on every activation. `invokeFunction` resolves the "currently deployed version" by reading that pointer and loading the referenced version's manifest, rather than by picking the most-recently-created version: a rollback reactivates an older version's files without adding a new manifest entry, so recency alone would keep enforcing the pre-rollback config (e.g. its `timeoutMs`) after a rollback to an earlier one.

`invokeFunction` calls the project's own API gateway at `{endpoints.api}/functions/v1/<name>` and enforces the currently-deployed version's `timeoutMs` via `AbortController`, inside an OpenTelemetry span (`withSpan`) so invocations are traced like the rest of the system.

`memoryMb` and `egressAllowlist` are validated and bounded on the artifact (`FunctionArtifactSchema`, ceilings of 512 MB and an explicit host allowlist) and persisted on every version manifest, but are **not** runtime-enforced in this change — there is no verified local mechanism to enforce them per function, and building an unverified one would be worse than declaring the gap. `timeoutMs` is the one ceiling enforced today, because it happens entirely inside our own `invokeFunction` call, not inside the CLI-managed runtime.

## Consequences

Agents can deploy, list, and roll back functions with the same auditability as migrations. A client that calls the Edge Runtime directly (bypassing `invokeFunction`) is not subject to our timeout, and no client is subject to our memory/egress ceilings yet. Enforcing those per function requires either an upstream Supabase CLI/Edge Runtime capability or moving to one Edge Runtime container per function so our own network-policy sidecar (`packages/executors/src/docker-network-policy-sidecar.ts`) and Docker resource limits could attach directly — both are larger changes tracked as follow-up, not part of this issue.

## Validation and rollback

Platform tests cover: deploy activating a version, writing `verify_jwt`, and writing the `current.json` pointer; path-containment rejection for out-of-workdir and mismatched-name sources; version listing order; rollback restoring prior content, updating the pointer to the rolled-back version, and rejecting unknown version ids and checksum mismatches; invocation success, non-2xx passthrough, timeout enforcement using the pointed-to version's `timeoutMs`, and rejection of invocation with no deployed version. Roll back by deploying a prior version's source again (there is no separate migration to undo — deployment is idempotent, content-addressed file replacement).
