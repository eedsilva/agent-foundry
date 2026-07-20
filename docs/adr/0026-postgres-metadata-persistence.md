# ADR 0026: Postgres adapters for domain metadata, behind a PERSISTENCE_MODE switch

- Status: Accepted
- Date: 2026-07-20
- Owners: Persistence

## Context

ADR 0003 deferred PostgreSQL for the local MVP: one trusted developer, filesystem persistence, inspectable state. That premise no longer covers every deployment target — multi-writer correctness (concurrent CAS updates), transactional guarantees across related writes, and a real migration story matter once agent-foundry runs anywhere beyond a single laptop process. The filesystem adapters and their tests stay authoritative for local development; issue #53 adds a second, ordinary implementation of the same domain ports rather than replacing the first.

## Decision

Add `packages/persistence/src/postgres/`: one adapter class per swapped port (`PostgresProjectRepository`, `PostgresWorkflowRunRepository`, `PostgresStepRunRepository`, `PostgresStepAttemptRepository`, `PostgresApprovalRequestRepository`, `PostgresApprovalDecisionRepository`, `PostgresEventStore`, `PostgresStepEventRepository`, `PostgresConversationRepository`, `PostgresArtifactStore`), all constructed from a shared `postgres.js` client (`createPostgresClient`, `PostgresDb`). Rows use a hybrid shape: columns for fields the domain queries or constrains (id, status, version, timestamps, foreign keys) and a `jsonb` column for the full validated entity, so reads stay a single round trip and writes stay schema-validated at the port boundary rather than duplicated across dozens of typed columns.

Schema migrations are embedded TypeScript/SQL (`postgres/migrations.ts`), applied by `migrateUp`/`migrateDown`/`assertSchemaCurrent` under an advisory lock (`pg_advisory_lock`) so concurrent boots or CI runs never race the same schema forward. Optimistic-concurrency writes reuse the file adapters' compare-and-swap contract (`VersionConflictError` on a stale `expectedVersion`), enforced in Postgres with a conditional `UPDATE ... WHERE version = $expected`.

`packages/composition` gains `PERSISTENCE_MODE: 'file' | 'postgres'` (default `file`) and an optional `DATABASE_URL`, validated together: `postgres` without `DATABASE_URL` is a fail-fast config error, not a runtime surprise. In postgres mode, `createRuntime` builds the client, calls `assertSchemaCurrent` once at boot — schema drift fails startup with a `db:migrate` pointer rather than auto-migrating in front of a running app — then constructs the ten Postgres adapters. Everything else (queue, metrics, quality observations, previews, model overrides, project versions, workflows, policies, workspaces) stays file-based in both modes; this ADR does not attempt a full production data plane in one step.

Because the adapters speak plain Postgres wire protocol through `postgres.js` rather than a provider SDK, a hosted Supabase project's Postgres instance works as `DATABASE_URL` with no code change and no `supabase-js` dependency — Supabase is the recommended default hosted target for this metadata layer (see `docs/OPERATIONS.md`'s "Migração para Postgres" for the connection string and pooler guidance); self-hosted Postgres (the `docker-compose.yml` service) remains supported as the non-hosted alternative.

## Alternatives considered

An ORM (Prisma/Drizzle) would generate types and migrations for us, but the domain ports already define the exact query surface each adapter needs; an ORM's schema-first modeling would fight the ports-and-adapters boundary rather than serve it. Auto-migrating on every boot was considered and rejected: a multi-instance deployment (API + worker sharing one database) racing a schema change on startup is a worse failure mode than requiring an explicit `npm run db:migrate` step.

## Consequences

`PostgresArtifactStore` stores blob content in `bytea`; that is a real ceiling for large screenshots/traces/videos and is explicitly deferred to #54 (object storage). The durable queue, metrics, and preview lifecycle remain filesystem-only pending #55 and later v0.8 tasks — Postgres mode does not yet make agent-foundry safely multi-writer end to end, only its metadata layer. Operators choosing postgres mode take on running and backing up a real database themselves; nothing here manages that lifecycle.

## Validation and rollback

```bash
npm run test:unit -- packages/persistence/src/postgres packages/composition/src/runtime.postgres.test.ts
npm run db:migrate
```

Each adapter has a Postgres-container test (`describePostgres`, gated on Docker) proving CRUD, CAS conflicts, and constraints match the file adapter's contract; `runtime.postgres.test.ts` proves `createRuntime` in postgres mode drives a full mock project run through the same ports the file mode uses, and that booting against an un-migrated database fails closed. Rollback is `PERSISTENCE_MODE=file` (or simply not setting it): the file adapters are untouched, and data written while in postgres mode does not sync back — see `docs/OPERATIONS.md`.
