import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SchemaPlanSchema } from './schema-plan.js';

async function readFixture(shape: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/schema-plan.json`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

function expectEveryTableHasRls(plan: {
  tables: { rls: { enabled: boolean; policies: unknown[] } }[];
}) {
  for (const table of plan.tables) {
    expect(table.rls.enabled).toBe(true);
    expect(table.rls.policies.length).toBeGreaterThan(0);
  }
}

describe('HA-0.1 schema plan fixtures (#480)', () => {
  it('validates the crud-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('crud-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual([
      'categories',
      'items',
      'stock_adjustments',
    ]);
    expectEveryTableHasRls(plan);
  });

  it('validates the dashboard-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('dashboard-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual(['sale_events']);
    expectEveryTableHasRls(plan);
  });

  it('validates the auth-heavy shape schema plan', async () => {
    const plan = SchemaPlanSchema.parse(await readFixture('auth-heavy'));
    expect(plan.tables.map((table) => table.name)).toEqual(['profiles']);
    expectEveryTableHasRls(plan);
    const profiles = plan.tables[0];
    if (!profiles) throw new Error('expected a profiles table');
    // RLS requirement from the PRD: member self-access + admin all-access,
    // both select and update.
    expect(profiles.rls.policies.map((policy) => policy.command).sort()).toEqual([
      'select',
      'select',
      'update',
      'update',
    ]);
  });
});
