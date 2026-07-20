# ADR 0025: Docker sandbox runner backend

- Status: Accepted
- Date: 2026-07-20
- Owners: Safety and Executors

## Context

ADR-0024 (issue #46) defined the `SandboxRunner` lifecycle contract but deliberately shipped no
backend — `LocalExecutionPlane` remained the only trusted path, running agent CLIs in-process with
full host permissions. Issue #47 requires a rootless container backend: non-root user, no
`--privileged`, minimal capabilities, a read-only root filesystem except a bounded workspace and
tmpfs, CPU/memory/pids/disk ceilings, a digest-pinned base image with a generated SBOM, and a
guarantee the host Docker socket is never mounted into a sandbox.

## Decision

`DockerSandboxRunner` (`packages/executors/src/docker-sandbox-runner.ts`) implements `SandboxRunner`
by shelling out to the `docker` CLI via `execa`, the same subprocess approach `BaseCliExecutor`
already uses for agent CLIs.

- `create()` runs `docker create` + `docker start` with `--user`, `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--pids-limit`, `--memory`/`--memory-swap`, `--cpus`, and
  `--network=none|bridge` (from `SandboxSpec.network.mode`). It never passes `--privileged`.
- The workspace and `/tmp` are `--tmpfs` mounts, not host bind mounts. Because the root filesystem
  is read-only, there is no container writable layer left to quota separately — every writable byte
  is one of these two size-capped tmpfs mounts. This is also why the disk ceiling
  (`SandboxSpec.resources.diskMiB`) is applied as the workspace tmpfs's `size=` rather than via
  `--storage-opt size=`: that flag only works on overlay2-over-xfs-with-pquota, which errors on this
  project's development machine and is not guaranteed on `ubuntu-latest` GitHub runners either
  (verified by hand before writing this ADR).
- `create()` rejects (before any Docker call) an image not pinned by digest (`@sha256:` must appear
  in `SandboxSpec.image`), and rejects any mount whose source or target references `docker.sock`, or
  whose target collides with the reserved `/workspace` or `/tmp` paths.
- `exec()` runs `docker exec -w /workspace <id> <command> <args...>` (no shell interpolation),
  streaming stdout/stderr chunks, honoring `timeoutMs` (throws on timeout), and honoring
  `AbortSignal` by throwing the same `RunCancelledError` used elsewhere in this codebase.
- `snapshot()` cannot use `docker cp`: verified by hand that `docker cp` fails to read a path mounted
  via `--tmpfs` on this Docker Desktop install (`Could not find the file`), even though the file is
  reachable via `docker exec ... cat`. Instead, `snapshot()` runs
  `docker exec <id> tar -cf - -C /workspace <path>` and pipes the tar stream into a host `tar -xf -`
  process, then reads the extracted files from a temp directory. A path that doesn't exist inside the
  sandbox is silently skipped (matches `SandboxRunner.snapshot`'s existing filtered-allowlist
  contract in `runSandboxLifecycle`).
- `destroy()` runs `docker rm -f`, tolerating "No such container" so repeated calls are safe, per the
  `SandboxRunner` interface's documented idempotency requirement.

Pinned base image for this ADR: `node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`
(resolved from `node:22-bookworm-slim`, 2026-07-20). An SBOM for this exact digest is generated on
every CI run by the `sandbox-sbom` job and archived at `docs/sbom/sandbox-image.spdx.json`.

## Scope boundary

This ADR does **not** wire `DockerSandboxRunner` into `packages/composition`'s runtime graph or the
orchestrator's `ExecutionPlane`. Nothing in the codebase constructs a `SandboxSpec` today —
`LocalExecutionPlane` remains the active execution path. Adding composition-level config (e.g. a
`SANDBOX_IMAGE` env var) now, with no caller to consume it, would be speculative. Making this backend
the default execution path is explicitly sequenced after `v07-network-policy` (egress allowlisting —
today `network.mode: 'allowlist'` only selects the bridge network, with no proxy/DNS enforcement yet)
and `v07-secret-broker` (scoped, revocable credentials) in the roadmap. Switching the default before
those land would give agents unrestricted container egress and no secret-lifetime control, which is
not an improvement over the documented `LocalExecutionPlane` posture in `docs/SECURITY.md`.

## Consequences

`SandboxRunner` now has a real, tested implementation satisfying issue #47's acceptance criteria.
`packages/composition` and the orchestrator are unchanged; `docs/SECURITY.md`'s "Isolamento de
processo" section is updated to reflect that the backend exists but is not yet the default.

## Validation and rollback

```bash
npx vitest run packages/executors/src/docker-sandbox-runner.test.ts
npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts
```

The integration suite requires a running Docker daemon; it is `describe.skipIf`-gated so `npm test`
still passes without one. `ubuntu-latest` GitHub Actions runners have Docker Engine preinstalled, so
CI exercises it for real. Roll back with a revert; `DockerSandboxRunner` is dead code with respect to
production behavior until a future issue wires it in, so reverting changes nothing currently running.
