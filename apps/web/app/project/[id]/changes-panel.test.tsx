import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangesPanel, editorHref } from './changes-panel';

describe('ChangesPanel', () => {
  // Version history moved to its own inspector tab (`inspector/versions-tab.tsx`),
  // per DESIGN.md §5.3, so the version controls are no longer rendered here —
  // `version-history.test.tsx` still covers them. What stays in this panel is
  // the editor link, the checks slot, and the approvals slot.
  it('keeps editor, checks, and approval controls reachable', () => {
    const workspacePath = '/tmp/project one/workspace';
    const markup = renderToStaticMarkup(
      <ChangesPanel
        workspacePath={workspacePath}
        checks={<p>checks current</p>}
        approvals={<p>approval pending</p>}
      />,
    );

    expect(editorHref(workspacePath)).toBe('vscode://file/%2Ftmp%2Fproject%20one%2Fworkspace');
    expect(markup).toContain('href="vscode://file/%2Ftmp%2Fproject%20one%2Fworkspace"');
    expect(markup).toContain('Checks');
    expect(markup).toContain('checks current');
    expect(markup).toContain('Aprovações');
    expect(markup).toContain('approval pending');
  });
});
