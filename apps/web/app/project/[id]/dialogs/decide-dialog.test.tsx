import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentArtifact } from '@agent-foundry/contracts';
import { DecideDialog, type DecideTarget } from './decide-dialog';

const assessment: AgentArtifact = {
  schemaVersion: '1',
  status: 'needs-revision',
  summary: 'Release has findings.',
  approved: false,
  data: {},
  decisions: [
    {
      title: 'Data path',
      choice: 'Review manually',
      rationale: 'The happy path is covered by the suite.',
      alternatives: [],
      consequences: [],
    },
  ],
  assumptions: [],
  risks: ['Browser smoke path needs a manual pass.'],
  nextActions: ['Run the protected URL check.'],
};

const target = {
  action: 'approve',
  node: {
    id: 'diff-approval',
    type: 'approval-gate',
    title: 'Human diff approval',
    artifact: 'release.review',
    outputArtifact: 'diff.approval',
    actions: ['approve', 'reject'],
    onReject: 'end',
    timeout: { policy: 'none' },
  },
  request: {
    id: 'approval-1',
    runId: 'run-1',
    nodeId: 'diff-approval',
    artifact: {
      name: 'release.review',
      revision: 1,
      sha256: 'a'.repeat(64),
    },
    createdAt: '2026-07-29T12:00:00.000Z',
  },
} as unknown as DecideTarget;

describe('DecideDialog release assessment', () => {
  it('renders findings before the approval control', () => {
    const markup = renderToStaticMarkup(
      <DecideDialog
        decideTarget={target}
        setDecideTarget={() => {}}
        decidePreview={null}
        decideReport={null}
        decideArtifact={assessment}
        decideDiff={null}
        decideNote=""
        setDecideNote={() => {}}
        decidedBy="ed"
        setDecidedBy={() => {}}
        decideError=""
        setDecideError={() => {}}
        deciding={false}
        setDeciding={() => {}}
        run={undefined}
        projectId="project-1"
        refresh={() => {}}
      />,
    );

    expect(markup).toContain('data-testid="agent-artifact-view"');
    expect(markup).toContain('Release has findings.');
    expect(markup).toContain('Status: needs-revision');
    expect(markup).toContain('Review manually');
    expect(markup).toContain('Browser smoke path needs a manual pass.');
    expect(markup).toContain('Run the protected URL check.');
    expect(markup.indexOf('Release has findings.')).toBeLessThan(
      markup.indexOf('Confirmar approve'),
    );
  });

  it('keeps reject controls available beside the assessment', () => {
    const markup = renderToStaticMarkup(
      <DecideDialog
        decideTarget={{ ...target, action: 'reject' }}
        setDecideTarget={() => {}}
        decidePreview={null}
        decideReport={null}
        decideArtifact={assessment}
        decideDiff={null}
        decideNote=""
        setDecideNote={() => {}}
        decidedBy="ed"
        setDecidedBy={() => {}}
        decideError=""
        setDecideError={() => {}}
        deciding={false}
        setDeciding={() => {}}
        run={undefined}
        projectId="project-1"
        refresh={() => {}}
      />,
    );

    expect(markup).toContain('Rejeitar encerra a execução');
    expect(markup).toContain('Confirmar reject');
  });
});
