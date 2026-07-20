import { MIGRATIONS } from './migrations.js';
import type { PostgresDb } from './client.js';

const MIGRATION_LOCK_KEY = 724_853_001; // arbitrary stable app-wide key

export function latestVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}

async function withMigrationLock<T>(sql: PostgresDb, fn: () => Promise<T>): Promise<T> {
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
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

export async function migrateUp(sql: PostgresDb): Promise<number[]> {
  return withMigrationLock(sql, async () => {
    await ensureLedger(sql);
    const applied = await appliedVersions(sql);
    const ran: number[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.up);
        await tx`insert into schema_migrations (version, name)
          values (${migration.version}, ${migration.name})`;
      });
      ran.push(migration.version);
    }
    return ran;
  });
}

export async function migrateDown(sql: PostgresDb, toVersion: number): Promise<number[]> {
  return withMigrationLock(sql, async () => {
    await ensureLedger(sql);
    const applied = await appliedVersions(sql);
    const ran: number[] = [];
    for (const migration of [...MIGRATIONS].reverse()) {
      if (migration.version <= toVersion || !applied.has(migration.version)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.down);
        await tx`delete from schema_migrations where version = ${migration.version}`;
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
