# ADR 0007: Use an isolated local Supabase stack per generated project

- Status: Accepted
- Date: 2026-07-12
- Owners: Core, Integrations
- Supersedes: ADR 0006 for Personal Builder v1

## Context

Personal v1 must deliver database, auth, storage and functions without Vercel, Supabase Cloud or a hosted Agent Foundry data plane. The operator wants locally owned services and one verified stack rather than provider portability in the first release.

## Decision

Every generated project receives an isolated Docker Compose Supabase stack locally and an isolated stack when published to the operator's VPS. V1 generates Next.js, TypeScript, Tailwind CSS and shadcn/ui applications. Email/password auth is always present; SMTP, OAuth and self-service password reset are excluded.

## Alternatives considered

Managed Supabase would reduce operations but violates the local-services requirement. A provider abstraction would enlarge the verification matrix before the golden path works. One shared Supabase installation increases coupling and blast radius between apps.

## Consequences

The release has a reproducible full-stack target and clear ownership. It accepts higher local/VPS resource use and Supabase-specific generated contracts. Provider portability can return after the v1 golden journey is reliable.

## Validation and rollback

Issue Radar must pass from clean local initialization through VPS deployment. The architectural decision can be superseded later; existing project exports must preserve code, migrations and data.
