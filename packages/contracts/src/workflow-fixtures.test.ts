import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema } from './workflow.js';

describe('web-app-v1 planner prompt carries the app-shape module contract (#479)', () => {
  it('stays a valid workflow definition and tells the planner to emit modules', async () => {
    const raw = await readFile(
      resolve(import.meta.dirname, '../../../workflows/web-app-v1.yaml'),
      'utf8',
    );
    const definition = WorkflowDefinitionSchema.parse(parse(raw));
    const planNode = definition.nodes.find((node) => node.id === 'plan');
    if (!planNode || planNode.type !== 'agent') {
      throw new Error('expected an agent node named plan');
    }
    expect(planNode.instructions).toMatch(/app-shape/i);
    expect(planNode.instructions).toMatch(/\bmodule\b/i);
    expect(definition.routing).toEqual([
      { taskKind: 'planning', executors: ['claude'] },
      { taskKind: 'implementation', executors: ['codex'] },
      { taskKind: 'repair', executors: ['codex'] },
      { taskKind: 'verification', executors: ['claude'] },
    ]);
  });

  it('documents the modules field and per-task module id in the planner role prompt', async () => {
    const role = await readFile(
      resolve(import.meta.dirname, '../../../harness/roles/planner.md'),
      'utf8',
    );
    expect(role).toMatch(/`modules`/);
    expect(role).toMatch(/`module`/);
  });
});
