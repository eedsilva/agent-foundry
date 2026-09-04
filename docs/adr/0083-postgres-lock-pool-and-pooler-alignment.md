# ADR 0083: The project mutation lock gets a transaction and its own pool, and the client follows the pooler

- Status: Accepted
- Date: 2026-09-03
- Owners: Persistence

Extends [0026](0026-postgres-metadata-persistence.md), which stands as written; this ADR supersedes only its "single shared client" and implicit prepared-statement clauses.

## Context

The PRD approval gate (#602) makes every enqueue surface hold one project-scoped critical section: approval check, queued run/operation persistence and job publication. In Postgres mode that section is served by `PostgresProjectMutationLock`, which ADR 0026 built on the single shared `postgres.js` client. Three properties of that arrangement stopped holding once the gate depended on it.

A session-scoped advisory lock (`pg_advisory_lock`) needs lock and unlock on the same backend. `sql.reserve()` pins the client→pooler socket, not the backend behind a transaction-mode pooler, so exclusion can be lost and the lock leaked — while `docs/OPERATIONS.md` promises pooler-safe runtime adapters.

A lock that holds its connection for the whole section, while the section itself does store I/O through the same pool, deadlocks at `max` concurrent sections: every connection is held by a section waiting for a connection. Measured against `postgres:17-alpine` with the product's own classes: 10 concurrent sections on distinct projects never complete; 9 complete.

Supabase's transaction pooler (port 6543) cannot serve named prepared statements, which `postgres.js` sends by default. That failure now lands inside `sql.begin`, where the driver's re-parse recovery does not help — the rejected statement aborts the transaction first.

## Decision

The lock takes `pg_advisory_xact_lock` inside `sql.begin`, reusing `acquireScopeLock` and the shape `PostgresPreviewLifecycleLock` already had; release comes from the commit/rollback.

Postgres mode opens two pools per process, one for the stores and one dedicated to the locks, so a section always has a store connection available to make progress with. With `max: 10` that is a ceiling of 20 connections per process.

`createPostgresClient` disables prepared statements when the URL points at port 6543, and keeps the driver default everywhere else. Detection is by port alone: every query parameter `postgres.js` does not recognise is forwarded in the startup packet, where the server rejects it (`FATAL: unrecognized configuration parameter`, measured against PostgreSQL 17.10), so honouring an invented flag such as `?pgbouncer=true` would trade a broken query for a broken connection. An operator pointing at a transaction pooler on another port passes the literal `?prepare=false`.

## Alternatives considered

Raising `max` instead of splitting the pool only moves the deadlock threshold; the cycle survives at any size. Passing the reserved connection into the critical section would remove it, but every store method would have to accept and thread that connection — a change to all Postgres adapters for a hazard the second pool closes in one line.

Turning prepared statements off unconditionally is smaller than the port predicate, and was rejected: it changes the production profile of direct Postgres, today's default target, to serve a target this repo has not yet exercised.

Leaving the pooler requirement to documentation was rejected once measured: only the literal `?prepare=false` (or `?prepare=disable`) works, while `?prepare=0` resolves to a truthy string and keeps prepared statements on silently, and `?no_prepare=true` is not read as an option at all. Both mistakes fail open, so the operator would carry a trap.

## Consequences

Postgres mode reaches up to twice `max` connections per process; size the database's connection limit by the number of API/worker processes. `PostgresPreviewLifecycleLock` still runs on the store pool and carries the original starvation hazard — tracked in #691, deliberately out of scope here.

Direct Postgres keeps prepared statements and is unaffected. The 6543 target loses them, which is the documented cost of that pooler.

## Validation and rollback

`packages/composition/src/runtime.postgres.test.ts` runs `max` concurrent lock sections against a real Postgres and fails by timeout without the dedicated pool. `packages/persistence/src/postgres/project-mutation-lock.test.ts` pins the transaction shape and the absence of a session lock. `packages/persistence/src/postgres/client.test.ts` pins the port predicate, that no invented flag drives it, and the fail-open spelling.

Executed proof against a real Supavisor/PgBouncer remains pending under #692; everything measured so far is PostgreSQL 17.10 directly.

Rollback is per clause and independent: dropping the port predicate restores the driver default everywhere at the cost of the 6543 target; constructing `PostgresProjectMutationLock` with the store client restores the single pool of ADR 0026; reverting the lock to `sql.reserve()` restores the session lock. None of them requires a data migration.
