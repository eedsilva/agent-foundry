import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DogfoodTaskSchema } from '@agent-foundry/contracts';
import { YamlWorkflowRepository } from '@agent-foundry/persistence';

const repoRoot = resolve(import.meta.dirname, '../../..');
const workflowsDir = resolve(repoRoot, 'workflows');
const tasksDir = resolve(repoRoot, 'examples/dogfood/tasks');

describe('dogfood workflows', () => {
  it('loads dogfood-task-v1 through the real workflow repository', async () => {
    const workflows = new YamlWorkflowRepository(workflowsDir);
    const workflow = await workflows.get('dogfood-task-v1');
    expect(workflow).toBeTruthy();
    expect(workflow.id).toBe('dogfood-task-v1');
  });

  it('loads dogfood-plan-v1 through the real workflow repository', async () => {
    const workflows = new YamlWorkflowRepository(workflowsDir);
    const workflow = await workflows.get('dogfood-plan-v1');
    expect(workflow).toBeTruthy();
    expect(workflow.id).toBe('dogfood-plan-v1');
  });
});

describe('dogfood task definitions', () => {
  it('every task file in examples/dogfood/tasks parses with DogfoodTaskSchema', async () => {
    const entries = (await readdir(tasksDir)).filter((name) => name.endsWith('.json'));
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const entry of entries) {
      const raw = await readFile(resolve(tasksDir, entry), 'utf8');
      const parsed = DogfoodTaskSchema.parse(JSON.parse(raw));
      expect(parsed.id.length).toBeGreaterThan(0);
    }
  });

  it('covers all five real v0.2 tasks by id', async () => {
    const entries = (await readdir(tasksDir)).filter((name) => name.endsWith('.json'));
    const tasks = await Promise.all(
      entries.map(async (entry) => {
        const raw = await readFile(resolve(tasksDir, entry), 'utf8');
        return DogfoodTaskSchema.parse(JSON.parse(raw));
      }),
    );
    const ids = tasks.map((task) => task.id).sort();
    expect(ids).toEqual(
      [
        'domain-redaction',
        'event-store-cursor',
        'executor-failure-fixtures',
        'failure-matrix-plan',
        'web-merge-events',
      ].sort(),
    );
  });
});
