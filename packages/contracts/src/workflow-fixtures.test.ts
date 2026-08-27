import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from './workflow.js';

async function loadWebAppWorkflow(): Promise<WorkflowDefinition> {
  const raw = await readFile(
    resolve(import.meta.dirname, '../../../workflows/web-app-v1.yaml'),
    'utf8',
  );
  return WorkflowDefinitionSchema.parse(parse(raw));
}

function taskExecutionNode(workflow: WorkflowDefinition) {
  const node = workflow.nodes.find((candidate) => candidate.id === 'task-execution');
  if (!node || node.type !== 'for-each-task') {
    throw new Error('expected a for-each-task node named task-execution');
  }
  return node;
}

describe('web-app-v1 planner prompt carries the app-shape module contract (#479)', () => {
  it('stays a valid workflow definition and tells the planner to emit modules', async () => {
    const definition = await loadWebAppWorkflow();
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

  it('negative drift guard: implementation check rejects maxAttempts other than 1 (#669)', async () => {
    expect(taskExecutionNode(await loadWebAppWorkflow()).implement.maxAttempts).toBe(1);
  });

  it('negative drift guard: repair check rejects maxAttempts other than 2 (#669)', async () => {
    expect(taskExecutionNode(await loadWebAppWorkflow()).repair?.maxAttempts).toBe(2);
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
