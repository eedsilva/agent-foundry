import { MIGRATIONS } from './migrations.js';
import type { PostgresDb } from './client.js';

const MIGRATION_LOCK_KEY = 724_853_001; // arbitrary stable app-wide key

export function latestVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}

// pg_advisory_lock/unlock are session-scoped: they must run on the same physical
// connection. postgres.js does not pin plain queries on a pooled client (max: 10)
// to one connection, so the unlock could land on a different session, leaking the
// lock while a concurrent migrator races past it. sql.reserve() pins the whole
// lock/work/unlock sequence to a single reserved connection, per the library docs.
async function withMigrationLock<T>(
  sql: PostgresDb,
  fn: (reserved: PostgresDb) => Promise<T>,
): Promise<T> {
  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      return await fn(reserved);
    } finally {
      await reserved`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    reserved.release();
  }
}

async function ensureLedger(sql: PostgresDb): Promise<void> {
  await sql`create table if not exists schema_migrations (
    version integer primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;
}

async function appliedVersions(sql: PostgresDb): Promise<Set<number>> {
  const rows = await sql<{ version: number }[]>`select version from schema_migrations`;
  return new Set(rows.map((row) => row.version));
}

// postgres.js only attaches `.begin()` to the top-level pooled `sql` (see
// node_modules/postgres/src/index.js) -- the object returned by `sql.reserve()` does
// NOT have it at runtime, even though the package's TS types claim `ReservedSql extends
// Sql`. Since a reserved connection is already pinned to one physical connection, a
// transaction there is just begin/commit/rollback issued directly on it.
async function withReservedTransaction(
  reserved: PostgresDb,
  run: () => Promise<void>,
): Promise<void> {
  await reserved.unsafe('begin');
  try {
    await run();
    await reserved.unsafe('commit');
  } catch (error) {
    await reserved.unsafe('rollback');
    throw error;
  }
}

export async function migrateUp(sql: PostgresDb): Promise<number[]> {
  return withMigrationLock(sql, async (reserved) => {
    await ensureLedger(reserved);
    const applied = await appliedVersions(reserved);
    const ran: number[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await withReservedTransaction(reserved, async () => {
        await reserved.unsafe(migration.up);
        await reserved`insert into schema_migrations (version, name)
          values (${migration.version}, ${migration.name})`;
      });
      ran.push(migration.version);
    }
    return ran;
  });
}

export async function migrateDown(sql: PostgresDb, toVersion: number): Promise<number[]> {
  return withMigrationLock(sql, async (reserved) => {
    await ensureLedger(reserved);
    const applied = await appliedVersions(reserved);
    const ran: number[] = [];
    for (const migration of [...MIGRATIONS].reverse()) {
      if (migration.version <= toVersion || !applied.has(migration.version)) continue;
      await withReservedTransaction(reserved, async () => {
        await reserved.unsafe(migration.down);
        await reserved`delete from schema_migrations where version = ${migration.version}`;
      });
      ran.push(migration.version);
    }
    return ran;
  });
}

export async function assertSchemaCurrent(sql: PostgresDb): Promise<void> {
  await ensureLedger(sql);
  const applied = await appliedVersions(sql);
  const missing = MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
  if (missing.length > 0) {
    throw new Error(
      `Postgres schema is behind: missing migrations [${missing.join(', ')}]. Run: npm run db:migrate`,
    );
  }
}
