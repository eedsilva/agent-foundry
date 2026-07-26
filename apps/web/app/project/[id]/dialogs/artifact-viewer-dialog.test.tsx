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
});
