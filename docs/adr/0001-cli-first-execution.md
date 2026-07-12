# ADR 0001: Use CLI-first executors for the trusted local MVP

- Status: Accepted
- Date: 2026-07-11
- Owners: Integrations

## Context

The personal MVP should use existing Codex, Claude, and AGY subscriptions without prematurely building billing and credential infrastructure.

## Decision

Expose each CLI behind `AgentExecutor`; keep provider commands and output parsing inside `packages/executors`. CLI execution is limited to the trusted-local deployment profile.

## Alternatives considered

Provider APIs offer stronger hosted controls but add metered billing, credential management, and different contracts before product value is proven.

## Consequences

Local adoption is faster, but concurrency, quota attribution, isolation, and auditability are constrained. Hosted mode must add API-backed executors instead of sharing personal CLI sessions.

## Validation and rollback

Adapter contract tests and real canaries validate supported CLI versions. A provider can be disabled without changing orchestration contracts.
