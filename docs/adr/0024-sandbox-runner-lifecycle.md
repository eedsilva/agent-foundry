# ADR 0024: Sandbox runner lifecycle boundary

- Status: Accepted
- Date: 2026-07-18
- Owners: Safety and Executors

## Context

Issue #46 requires one auditable contract for an isolated execution environment before a rootless container backend exists.

## Decision

SandboxSpec strictly carries image, CPU/memory/disk/PID ceilings, network policy, mounts, TTL, and user. SandboxRunner owns create, exec, snapshot, and idempotent destroy. runSandboxLifecycle forwards timeout, output streaming, and cancellation; filters exported files to caller-approved relative paths; and destroys every created sandbox in finally. The agent-facing shapes contain no control-plane API capability.

## Consequences

This is a contract boundary, not a sandbox implementation: LocalExecutionPlane remains the trusted local-development path until #47 supplies a rootless backend. Callers must provide explicit snapshot allowlists; files outside them are discarded.

## Validation and rollback

packages/domain/src/sandbox-runner.test.ts proves success, streaming, allowed-path filtering, and cleanup after exec/snapshot failure. Roll back with a revert; all values are transient and unpersisted.
