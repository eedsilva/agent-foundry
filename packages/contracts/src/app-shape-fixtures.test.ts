import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppShapeSchema } from './plan.js';

async function readFixture(shape: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/app-shape.json`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('HA-0.1 app-shape fixtures (#478)', () => {
  it('validates the crud-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('crud-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual([
      'auth',
      'crud:categories',
      'crud:items',
      'crud:stock-adjustments',
    ]);
  });

  it('validates the dashboard-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('dashboard-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual([
      'auth',
      'dashboard',
      'crud:sale-events',
    ]);
  });

  it('validates the auth-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('auth-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual(['auth', 'crud:profiles']);
  });
});
