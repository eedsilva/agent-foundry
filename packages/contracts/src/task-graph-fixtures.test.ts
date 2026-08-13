import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppShapeSchema, GeneratedTaskGraphSchema } from './plan.js';

async function readShapeFixture(shape: string, file: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/${file}`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

async function expectModuleMappedGraph(shape: string, moduleIds: string[]) {
  const appShape = AppShapeSchema.parse(await readShapeFixture(shape, 'app-shape.json'));
  const graph = GeneratedTaskGraphSchema.parse(await readShapeFixture(shape, 'task-graph.json'));
  expect(appShape.modules.map((module) => module.id)).toEqual(moduleIds);
  expect(graph.modules.map((module) => module.id)).toEqual(moduleIds);
  expect(graph.modules).toEqual(appShape.modules);
  const referencedModules = new Set(graph.tasks.map((task) => task.module));
  expect([...referencedModules].sort()).toEqual([...moduleIds].sort());
}

describe('HA-0.1 task-graph fixtures map 1:1 onto app-shape modules (#479)', () => {
  it('validates the crud-heavy shape task graph', async () => {
    await expectModuleMappedGraph('crud-heavy', [
      'auth',
      'crud:categories',
      'crud:items',
      'crud:stock-adjustments',
    ]);
  });

  it('validates the dashboard-heavy shape task graph', async () => {
    await expectModuleMappedGraph('dashboard-heavy', ['auth', 'dashboard', 'crud:sale-events']);
  });

  it('validates the auth-heavy shape task graph', async () => {
    await expectModuleMappedGraph('auth-heavy', ['auth', 'crud:profiles']);
  });
});
