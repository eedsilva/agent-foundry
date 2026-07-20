import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.js';
import { latestVersion, migrateDown, migrateUp } from './migrator.js';
import { describePostgres } from './testing.js';

describe('migrations manifest', () => {
  it('has strictly increasing versions starting at 1', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(latestVersion()).toBe(MIGRATIONS.length);
  });
});

describePostgres('postgres migrator', (ctx) => {
  it('applies all migrations up, is idempotent, and reverts down', async () => {
    const sql = ctx.db();
    // describePostgres already ran migrateUp; a second run applies nothing.
    expect(await migrateUp(sql)).toEqual([]);
    const [row] = await sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name = 'projects'`;
    expect(row?.count).toBe(1);
    const reverted = await migrateDown(sql, 0);
    expect(reverted).toEqual(MIGRATIONS.map((m) => m.version).reverse());
    const [afterRow] = await sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name = 'projects'`;
    expect(afterRow?.count).toBe(0);
    expect(await migrateUp(sql)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('assertSchemaCurrent throws when behind and passes when current', async () => {
    const sql = ctx.db();
    const { assertSchemaCurrent } = await import('./migrator.js');
    await expect(assertSchemaCurrent(sql)).resolves.toBeUndefined();
    await migrateDown(sql, 0);
    await expect(assertSchemaCurrent(sql)).rejects.toThrow(/db:migrate/);
    await migrateUp(sql);
  });

  // Regression guard for the advisory lock racing two concurrent migrators (issue #53).
  // This only fails *plausibly*, not reliably, under the broken (non-reserved-connection)
  // locking -- timing-dependent races are inherently flaky to catch in a unit test. The
  // real proof that the lock can't leak across connections is the sql.reserve() structure
  // in withMigrationLock itself, not this test.
  it('applies each migration exactly once under concurrent migrateUp', async () => {
    const sql = ctx.db();
    await migrateDown(sql, 0);
    const [first, second] = await Promise.all([migrateUp(sql), migrateUp(sql)]);
    const combined = [...(first ?? []), ...(second ?? [])].sort((a, b) => a - b);
    expect(combined).toEqual(MIGRATIONS.map((m) => m.version));
    const rows = await sql<{ version: number }[]>`select version from schema_migrations order by version`;
    expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });
});
