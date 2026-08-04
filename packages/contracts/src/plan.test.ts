import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  TaskGraphArtifactSchema,
  TaskGraphSchema,
} from './plan.js';

const graph = {
  schemaVersion: '1' as const,
  goal: 'Ship the issue radar MVP',
  tasks: [
    {
      id: 'T1',
      title: 'Create the issues table',
      deliverables: ['supabase/migrations/0001_issues.sql'],
      acceptanceCheck: 'Migration applies and the issues table exists',
    },
    {
      id: 'T2',
      title: 'List issues in the UI',
      dependsOn: ['T1'],
      deliverables: ['apps/web/app/issues/page.tsx'],
      acceptanceCheck: 'Visiting /issues renders the seeded issue titles',
    },
  ],
};

describe('task graph contracts', () => {
  it('exports the task graph schemas', () => {
    expect('TaskGraphSchema' in contracts).toBe(true);
    expect('TaskGraphArtifactSchema' in contracts).toBe(true);
    expect('TASK_GRAPH_ARTIFACT_JSON_SCHEMA' in contracts).toBe(true);
  });

  it('accepts a valid graph and keeps the planner prose fields', () => {
    expect(TaskGraphSchema.parse(graph)).toMatchObject({
      goal: 'Ship the issue radar MVP',
      tasks: [
        { id: 'T1', dependsOn: [] },
        { id: 'T2', dependsOn: ['T1'] },
      ],
    });
  });

  it('accepts explicit deterministic and browser acceptance modes', () => {
    const parsed = TaskGraphSchema.parse({
      ...graph,
      tasks: [
        { ...graph.tasks[0], acceptanceMode: 'deterministic-only' },
        { ...graph.tasks[1], acceptanceMode: 'browser-visible' },
      ],
    });
    expect(parsed.tasks.map((task) => task.acceptanceMode)).toEqual([
      'deterministic-only',
      'browser-visible',
    ]);
  });

  it('keeps historical graphs readable and rejects unknown acceptance modes', () => {
    expect(TaskGraphSchema.parse(graph).tasks[0]?.acceptanceMode).toBeUndefined();
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], acceptanceMode: 'maybe-browser' }],
      }),
    ).toThrow();
  });

  it('requires acceptance modes from new planner output while retaining historical reads', () => {
    expect(() =>
      GeneratedTaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: graph,
      }),
    ).toThrow(/acceptanceMode/);
    expect(
      GeneratedTaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: {
          ...graph,
          tasks: graph.tasks.map((task, index) => ({
            ...task,
            acceptanceMode: index === 0 ? 'deterministic-only' : 'browser-visible',
          })),
        },
      }).data.tasks,
    ).toHaveLength(2);
  });

  it('rejects a malformed graph', () => {
    expect(() => TaskGraphSchema.parse({ schemaVersion: '1', tasks: [] })).toThrow();
    expect(() =>
      TaskGraphSchema.parse({
        schemaVersion: '1',
        tasks: [{ id: 'T1', title: 'No acceptance check', deliverables: ['x'] }],
      }),
    ).toThrow();
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [...graph.tasks, { ...graph.tasks[0], title: 'Duplicate id' }],
      }),
    ).toThrow(/Duplicate task id T1/);
  });

  it('applies the dependsOn default and accepts a diamond dependency graph', () => {
    const task = (id: string, dependsOn?: string[]) => ({
      id,
      title: `Task ${id}`,
      ...(dependsOn ? { dependsOn } : {}),
      deliverables: [`${id}.ts`],
      acceptanceCheck: `${id} works`,
    });
    const parsed = TaskGraphSchema.parse({
      schemaVersion: '1',
      tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T1']), task('T4', ['T2', 'T3'])],
    });
    expect(parsed.tasks[0]?.dependsOn).toEqual([]);
    expect(parsed.tasks[3]?.dependsOn).toEqual(['T2', 'T3']);
  });

  it('rejects invalid task ids, empty deliverables, and a wrong schema version', () => {
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], id: 'not a path segment' }],
      }),
    ).toThrow();
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], deliverables: [] }],
      }),
    ).toThrow();
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], deliverables: [''] }],
      }),
    ).toThrow();
    expect(() => TaskGraphSchema.parse({ ...graph, schemaVersion: '2' })).toThrow();
  });

  it('caps the graph at 100 tasks', () => {
    const tasks = Array.from({ length: 101 }, (_, index) => ({
      id: `T${index}`,
      title: `Task ${index}`,
      deliverables: ['x.ts'],
      acceptanceCheck: 'works',
    }));
    expect(() => TaskGraphSchema.parse({ schemaVersion: '1', tasks })).toThrow();
    expect(
      TaskGraphSchema.parse({ schemaVersion: '1', tasks: tasks.slice(0, 100) }).tasks,
    ).toHaveLength(100);
  });

  it('rejects a dependency on an unknown task', () => {
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], dependsOn: ['T9'] }],
      }),
    ).toThrow(/unknown task T9/);
  });

  it('rejects a dependency cycle', () => {
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [
          { ...graph.tasks[0], dependsOn: ['T2'] },
          { ...graph.tasks[1], dependsOn: ['T1'] },
        ],
      }),
    ).toThrow(/Dependency cycle among tasks: T1, T2/);
    expect(() =>
      TaskGraphSchema.parse({
        ...graph,
        tasks: [{ ...graph.tasks[0], dependsOn: ['T1'] }],
      }),
    ).toThrow(/Dependency cycle among tasks: T1/);
  });

  it('reports every task stuck behind a longer cycle', () => {
    const task = (id: string, dependsOn: string[]) => ({
      id,
      title: `Task ${id}`,
      dependsOn,
      deliverables: [`${id}.ts`],
      acceptanceCheck: `${id} works`,
    });
    // T1→T2→T3→T1 is the cycle; T4 depends on it but is not part of it — yet it
    // can never be ordered either, so Kahn reports all four as stuck.
    expect(() =>
      TaskGraphSchema.parse({
        schemaVersion: '1',
        tasks: [task('T1', ['T3']), task('T2', ['T1']), task('T3', ['T2']), task('T4', ['T3'])],
      }),
    ).toThrow(/Dependency cycle among tasks: T1, T2, T3, T4/);
  });

  it('wraps the graph in the agent artifact envelope', () => {
    expect(
      TaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: graph,
      }).data.tasks,
    ).toHaveLength(2);
    expect(() =>
      TaskGraphArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the MVP',
        data: { note: 'prose instead of a graph' },
      }),
    ).toThrow();
  });

  it('publishes a model-facing JSON schema with the runtime validation marker', () => {
    expect(TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id).toMatch(/task-graph-artifact-v1/);
    expect(TASK_GRAPH_ARTIFACT_JSON_SCHEMA['x-agent-foundry-runtime-validation']).toBeDefined();
  });
});
