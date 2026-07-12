# ADR 0002: Persist handoffs as versioned artifacts

- Status: Accepted
- Date: 2026-07-11
- Owners: Core

## Context

Volatile conversational memory makes retries, review, resumption, and auditing ambiguous.

## Decision

Each workflow step reads named artifact revisions and writes validated immutable revisions. Decisions, model routes, prompts, reviews, and verification reports are artifacts or events.

## Alternatives considered

A single long agent conversation is simpler initially but cannot reliably reproduce state or isolate failures.

## Consequences

The system gains traceability and replay boundaries at the cost of schema/version management and additional storage.

## Validation and rollback

Artifact hashes and contracts are tested. Contract changes require compatibility or migration.
