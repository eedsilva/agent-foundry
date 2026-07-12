# ADR 0003: Use filesystem persistence only for the local MVP

- Status: Accepted
- Date: 2026-07-11
- Owners: Core

## Context

The first product target is one trusted developer. Inspectability and low setup cost matter more than distributed throughput.

## Decision

Use atomic files, JSONL events, immutable artifact revisions, and a directory queue behind repository interfaces.

## Alternatives considered

PostgreSQL and a managed queue would improve concurrency and transactions but add operational surface before usage validates them.

## Consequences

Local debugging is transparent. Multi-process recovery and cross-resource transactions remain limited and move to the hosted data-plane track.

## Validation and rollback

Persistence ports isolate the implementation. Production adapters can replace filesystem repositories without changing domain contracts.
