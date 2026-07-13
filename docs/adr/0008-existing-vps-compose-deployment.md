# ADR 0008: Publish Personal v1 to an existing VPS with Docker Compose

- Status: Accepted
- Date: 2026-07-12
- Owners: Integrations, Safety

## Context

Personal v1 needs a complete publish loop without Vercel or cloud provisioning. The owner already controls the destination and accepts SSH-based administration.

## Decision

The only v1 production adapter targets an existing Ubuntu LTS VPS over SSH, with Debian compatibility best effort. It deploys one isolated Compose project per app and uses Caddy for reverse proxying and TLS. DNS changes remain manual. Backups stay on the VPS and are copied to the local Mac.

Application rollback restores application code and container configuration only. Database migrations are forward-moving; restore is a separate approved operation.

## Alternatives considered

Cloud provisioning adds provider APIs and infrastructure lifecycle outside the v1 goal. Platform deployment vendors reduce ownership. Atomic database rollback is unsafe to promise across arbitrary data migrations.

## Consequences

The deployment surface is narrow and testable. The operator owns VPS security, availability and capacity. SSH and `.env` remain sensitive trusted-local boundaries.

## Validation and rollback

Issue Radar deploys to a clean Ubuntu LTS fixture, passes health and browser checks, configures optional TLS after manual DNS, copies a verified backup to the Mac and redeploys a prior app version without reversing the database.
