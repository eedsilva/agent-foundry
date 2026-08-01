# ADR 0051: Normalize JSON Schema before Claude CLI execution

- Status: Accepted
- Date: 2026-08-01
- Owners: Core, Platform
- Builds on ADR 0001 (CLI-first execution)

## Context

Real-mode validation reached the Claude CLI with a valid nested JSON Schema,
but Claude rejected the request because its strict schema validator does not
accept the `prefixItems` keyword. The failure occurred before the agent could
produce structured output, so the workflow could not reach its browser gate.

## Decision

The Claude executor serializes a Claude-compatible copy of every output schema
before passing it to `--json-schema`. The adapter recursively removes
`$schema`, `prefixItems`, and extension keys beginning with `x-`; the source
artifact contract remains unchanged for other executors and persisted records.

## Alternatives considered

- **Pass the schema through unchanged.** Rejected because Claude rejects
  nested unsupported keywords before execution.
- **Rewrite each caller's schema.** Rejected because it duplicates provider
  compatibility knowledge and leaves sibling callers exposed.
- **Remove tuple keywords from the shared contract.** Rejected because other
  providers and validators may rely on the full schema.

## Consequences

Claude receives a narrower, provider-compatible schema while the rest of the
execution plane retains the canonical contract. Tuple-specific constraints
are not enforced by Claude's structured-output validator and must remain
covered by downstream artifact validation.

## Validation and rollback

The executor test covers removal of a nested `prefixItems` keyword. The full
repository check, build, and secrets scan passed. Rollback is a revert of the
implementation commit; it restores pass-through schema serialization.
