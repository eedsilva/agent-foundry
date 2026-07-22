import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { ChangesPanel, ProjectBuilderShell, editorHref } from './changes-panel';

const version: ProjectVersion = {
  schemaVersion: '1',
  id: 'version-1',
  projectId: 'project-1',
  sequence: 1,
  kind: 'run',
  runId: 'run-1',
  commit: 'abc123def456',
  artifacts: [],
  protected: false,
  version: 1,
  createdAt: '2026-07-21T12:00:00.000Z',
};

describe('ProjectBuilderShell', () => {
  it('keeps Chat, Preview, and Changes in mobile document order', () => {
    const markup = renderToStaticMarkup(
      <ProjectBuilderShell
        chat={<section role="region" aria-label="Chat" />}
        preview={<section role="region" aria-label="Preview" />}
        changes={<section role="region" aria-label="Changes" />}
      />,
    );

    expect(
      [...markup.matchAll(/aria-label="(Chat|Preview|Changes)"/g)].map((match) => match[1]),
    ).toEqual(['Chat', 'Preview', 'Changes']);
  });
});

describe('ChangesPanel', () => {
  it('keeps editor, version, diff, checks, and approval controls reachable', () => {
    const workspacePath = '/tmp/project one/workspace';
    const markup = renderToStaticMarkup(
      <ChangesPanel
        projectId="project-1"
        workspacePath={workspacePath}
        initialVersions={[version]}
        checks={<p>checks current</p>}
        approvals={<p>approval pending</p>}
      />,
    );

    expect(editorHref(workspacePath)).toBe('vscode://file/%2Ftmp%2Fproject%20one%2Fworkspace');
    expect(markup).toContain('href="vscode://file/%2Ftmp%2Fproject%20one%2Fworkspace"');
    expect(markup).toContain('Comparar selecionadas');
    expect(markup).toContain('Reverter');
    expect(markup).toContain('Branch');
    expect(markup).toContain('Proteger');
    expect(markup).toContain('Checks');
    expect(markup).toContain('Aprovações');
  });
});
