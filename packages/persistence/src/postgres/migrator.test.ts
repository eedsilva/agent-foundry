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
});
