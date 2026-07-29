import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ApprovalGateStep, ApprovalRequest, StoredArtifact } from '@agent-foundry/contracts';
import { ChangesTab } from './changes-tab';

const artifact = {
  metadata: {
    projectId: 'project-1',
    name: 'release.review',
    revision: 1,
    contentType: 'application/json',
    createdAt: '2026-07-29T12:00:00.000Z',
    createdBy: 'agent:release-assessment',
    sha256: 'a'.repeat(64),
  },
  content: {
    schemaVersion: '1',
    status: 'needs-revision',
    summary: 'Findings beside the controls.',
    data: {},
    decisions: [],
    assumptions: [],
    risks: ['Protected route needs review.'],
    nextActions: ['Open the direct URL.'],
  },
} as StoredArtifact;

const request = {
  id: 'approval-1',
  runId: 'run-1',
  nodeId: 'diff-approval',
  artifact: { name: 'release.review', revision: 1, sha256: 'a'.repeat(64) },
  createdAt: '2026-07-29T12:00:00.000Z',
} as ApprovalRequest;

const node = {
  id: 'diff-approval',
  type: 'approval-gate',
  title: 'Human diff approval',
  artifact: 'release.review',
  outputArtifact: 'diff.approval',
  actions: ['approve', 'reject'],
  onReject: 'end',
  timeout: { policy: 'none' },
} as ApprovalGateStep;

describe('ChangesTab release findings', () => {
  it('renders an AgentArtifact beside approval controls', () => {
    const markup = renderToStaticMarkup(
      <ChangesTab
        projectId="project-1"
        workspacePath="/tmp/workspace"
        changesReport={null}
        artifacts={[artifact]}
        approvals={[{ request, decision: null }]}
        nodeForRequest={() => node}
        onOpenDecide={() => {}}
        onOpenArtifactRef={() => {}}
      />,
    );

    expect(markup).toContain('Findings beside the controls.');
    expect(markup).toContain('Protected route needs review.');
    expect(markup).toContain('Open the direct URL.');
    expect(markup).toContain('>approve</button>');
    expect(markup).toContain('>reject</button>');
  });
});
