import { describe, expect, it } from 'vitest';
import type { PlanTask } from '@agent-foundry/contracts';
import { isTaskStepId, nextReadyTask, readyTasks, taskStepId } from './task-graph.js';

function task(id: string, dependsOn: string[] = []): PlanTask {
  return {
    id,
    title: `Task ${id}`,
    dependsOn,
    deliverables: ['src/index.ts'],
    acceptanceCheck: 'it works',
  };
}

describe('nextReadyTask', () => {
  it('walks dependency order rather than declaration order', () => {
    const tasks = [task('T1', ['T2']), task('T2')];
    const completed = new Set<string>();

    const first = nextReadyTask(tasks, completed);
    expect(first?.id).toBe('T2');
    completed.add('T2');
    expect(nextReadyTask(tasks, completed)?.id).toBe('T1');
  });

  it('holds a task back until every blocker completed', () => {
    const tasks = [task('T1'), task('T2'), task('T3', ['T1', 'T2'])];

    expect(nextReadyTask(tasks, new Set(['T1']))?.id).toBe('T2');
    expect(nextReadyTask(tasks, new Set(['T1', 'T2']))?.id).toBe('T3');
  });

  it('returns undefined once every task completed', () => {
    const tasks = [task('T1'), task('T2', ['T1'])];

    expect(nextReadyTask(tasks, new Set(['T1', 'T2']))).toBeUndefined();
  });
});

describe('readyTasks', () => {
  it('reproduces nextReadyTask when running is empty', () => {
    const tasks = [task('T1', ['T2']), task('T2')];

    expect(readyTasks(tasks, new Set())).toEqual([task('T2')]);
    expect(readyTasks(tasks, new Set(), new Set())[0]).toEqual(nextReadyTask(tasks, new Set()));
  });

  it('does not re-offer a task that is already running', () => {
    const tasks = [task('T1'), task('T2')];

    expect(readyTasks(tasks, new Set(), new Set(['T1']))).toEqual([task('T2')]);
  });

  it('returns two independent tasks both', () => {
    const tasks = [task('T1'), task('T2')];

    expect(readyTasks(tasks, new Set()).map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('holds back a task blocked by a running (not completed) dependency', () => {
    const tasks = [task('T1'), task('T2', ['T1'])];

    expect(readyTasks(tasks, new Set(), new Set(['T1']))).toEqual([]);
  });
});

describe('task step ids', () => {
  it('round-trips the declared step id', () => {
    expect(taskStepId('implement', 'T1')).toBe('implement.T1');
    expect(isTaskStepId('implement.T1', 'implement')).toBe(true);
    expect(isTaskStepId('implement', 'implement')).toBe(true);
  });

  it('does not match another step that merely shares a prefix', () => {
    expect(isTaskStepId('implement-extra', 'implement')).toBe(false);
    expect(isTaskStepId('review-code', 'implement')).toBe(false);
  });
});
