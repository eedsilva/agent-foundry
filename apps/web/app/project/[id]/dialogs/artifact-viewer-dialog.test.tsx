import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { StoredArtifact } from '@agent-foundry/contracts';
import { ArtifactViewerDialog } from './artifact-viewer-dialog';

function storedArtifact(content: unknown): StoredArtifact {
  return {
    metadata: {
      projectId: 'project-1',
      name: 'plan.current',
      revision: 1,
      contentType: 'application/json',
      createdAt: '2026-07-26T12:00:00.000Z',
      createdBy: 'planner:mock/default',
      sha256: 'a'.repeat(64),
    },
    content,
  } as StoredArtifact;
}

function render(content: unknown): string {
  return renderToStaticMarkup(
    <ArtifactViewerDialog
      projectId="project-1"
      selected={storedArtifact(content)}
      setSelected={() => {}}
      showDiff={false}
      setShowDiff={() => {}}
      previousArtifact={null}
      setPreviousArtifact={() => {}}
      setError={() => {}}
    />,
  );
}

describe('ArtifactViewerDialog task graph rendering', () => {
  it('renders a conforming plan as a readable task list', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned.',
      data: {
        schemaVersion: '1',
        tasks: [
          {
            id: 'T1',
            title: 'Create the issues table',
            deliverables: ['0001_issues.sql'],
            acceptanceCheck: 'Migration applies',
          },
          {
            id: 'T2',
            title: 'List issues',
            dependsOn: ['T1'],
            deliverables: ['issues/page.tsx'],
            acceptanceCheck: '/issues renders titles',
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });

    expect(markup).toContain('data-testid="task-graph-view"');
    expect(markup).toContain('T1 · Create the issues table');
    expect(markup).toContain('Depende de: T1');
    expect(markup).toContain('Aceite: Migration applies');
  });

  it('falls back to raw JSON for a non-graph artifact', () => {
    const markup = render({ note: 'prose plan' });
    expect(markup).not.toContain('data-testid="task-graph-view"');
    expect(markup).toContain('prose plan');
  });

  it('falls back to raw JSON for a graph that fails validation instead of crashing', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned.',
      data: {
        schemaVersion: '1',
        tasks: [
          {
            id: 'T1',
            title: 'Depends on a missing task',
            dependsOn: ['T9'],
            deliverables: ['x.ts'],
            acceptanceCheck: 'never',
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });
    expect(markup).not.toContain('data-testid="task-graph-view"');
    expect(markup).toContain('Depends on a missing task');
  });
});

describe('ArtifactViewerDialog schema plan rendering', () => {
  it('renders a conforming schema plan as a readable table list', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned the schema.',
      data: {
        schemaVersion: '1',
        tables: [
          {
            name: 'items',
            columns: [
              { name: 'id', type: 'uuid', nullable: false },
              { name: 'name', type: 'text', nullable: false },
            ],
            constraints: [{ type: 'primary-key', columns: ['id'] }],
            indexes: [],
            rls: {
              enabled: true,
              policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
            },
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });

    expect(markup).toContain('data-testid="schema-plan-view"');
    expect(markup).toContain('items');
    expect(markup).toContain('id (uuid)');
    expect(markup).toContain('all · authenticated_all');
  });

  it('falls back to raw JSON for a schema plan that fails validation instead of crashing', () => {
    const markup = render({
      schemaVersion: '1',
      status: 'completed',
      summary: 'Planned the schema.',
      data: {
        schemaVersion: '1',
        tables: [
          {
            name: 'items',
            columns: [{ name: 'id', type: 'uuid', nullable: false }],
            constraints: [],
            indexes: [],
            // No RLS declared — invalid.
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    });

    expect(markup).not.toContain('data-testid="schema-plan-view"');
    expect(markup).toContain('items');
  });
});
