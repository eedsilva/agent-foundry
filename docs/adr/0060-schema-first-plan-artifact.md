# ADR 0060: Schema-first plan artifact for the generated data model

- Status: Accepted
- Date: 2026-08-08
- Owners: Core, Platform
- Tracked by epic #471 (build tickets #480, #481)

## Context

Generated Supabase/Postgres schemas are produced implicitly during implementation tasks:
tables appear ad hoc, RLS and constraints are inconsistent, and migration quality varies
per run. Migrations are forward-only by contract, so a bad table shipped is a bad table
kept. The cheapest place to catch a bad data model is before any implementation task runs.

Alternative considered: post-hoc migration lint (RLS present, constraints in DB,
forward-only) — lighter, but it catches defects after code was generated against the bad
schema, wasting repair cycles.

## Decision

The data model becomes a schema-first plan artifact: tables, columns, constraints, indexes,
and per-table RLS policies, validated and operator-reviewable before implementation tasks
execute. Migrations are generated from the artifact, keeping constraints in the database
rather than app code. A migration lint may be added later as belt-and-braces; it is not the
authority.

## Consequences

- New (or extended) plan artifact contract; destructive-migration approval keeps its
  existing gate.
- Implementation tasks receive the schema as input context instead of inventing tables.
- Repair loops for data-model defects move from post-build to pre-build review.
