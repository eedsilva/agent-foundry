# ADR 0006: Use portable managed-backend adapters for Personal v1

- Status: Accepted
- Date: 2026-07-11
- Owners: Integrations

## Context

A Lovable-class personal builder needs database, auth, storage, functions, and secrets, but building an internal platform would drag hosted infrastructure into the Personal v1 critical path.

## Decision

Generate and manage backend capabilities through portable provider adapters and explicit project contracts. Keep Agent Foundry's own production data plane separate from the backend generated for user applications.

## Alternatives considered

Owning database/auth/storage infrastructure immediately increases lock-in, security scope, and operational burden without proving demand.

## Consequences

Personal v1 ships sooner and remains portable. Provider-specific limitations must be visible, and migrations/exports are part of the contract.

## Validation and rollback

Golden projects exercise at least one managed provider and export/migration path. A provider adapter can be replaced without changing the builder's domain model.
