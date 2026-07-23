# ADR 0030: Initialize an isolated runtime for each generated project

- Status: Accepted
- Date: 2026-07-22
- Owners: Core, Integrations
- Extends: ADR 0007

## Context

Real project creation needs database infrastructure before orchestration starts, while mock-mode development and CI must remain Docker-free. The Supabase CLI owns a project-local configuration tree and exposes credentials in command output, so runtime state needs an explicit source and a secret-free persistence boundary.

## Decision

In real execution mode, `ProjectService.create` initializes `SupabaseGeneratedProjectRuntime` after creating the workspace and before writing the PRD or persisting the project. Mock mode does not construct a generated-project runtime.

`DATA_DIR/projects/<projectId>/environment/` is the CLI-owned source for that project's runtime configuration. Its `environment.json` records only validated resource names, paths, ports, credential-free endpoints and health timestamps; credentials and raw CLI output are never persisted there.

Reset and cleanup require explicit confirmation plus the timestamp of a backup created independently of the runtime within the previous 24 hours. Issues #70, #71, #72 and #73 own migration, authentication, storage and functions semantics respectively; this ADR does not define them.

## Alternatives considered

A shared Supabase stack would reduce startup cost but increase cross-project coupling and blast radius. Initializing lazily on first database use would let orchestration begin without its required environment. Constructing the adapter in mock mode would make existing deterministic tests depend on the Supabase CLI and Docker.

## Consequences

Real project creation now fails before project persistence when environment initialization fails. Each project consumes isolated Docker resources and host ports. Mock mode keeps its current fast, Docker-free path. Runtime metadata can be inspected and backed up without exposing database credentials.

## Validation and rollback

Focused orchestration tests prove initialization precedes project persistence, and composition tests prove mock mode exposes no generated-project runtime. Platform adapter tests cover isolation, idempotency, secret filtering and destructive-operation confirmation. Roll back by removing the composition wiring; preserve each project environment directory and its independently created backups.
