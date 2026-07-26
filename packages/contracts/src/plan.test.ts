import { describe, expect, it } from 'vitest';
import * as contracts from './index.js';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
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
