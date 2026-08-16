import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentArtifact } from '@agent-foundry/contracts';
import { AgentArtifactView } from './agent-artifact-view';

function makeArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: 'Resumo curto.',
    data: {},
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
    ...overrides,
  };
}

describe('AgentArtifactView', () => {
  // #97 task 3 fix round 1: this is agent-authored free text — `summary`,
  // `risks`, `decisions` and `nextActions` can contain a stack trace, a URL,
  // or an absolute path, none of which are exotic here. A 390px Playwright
  // probe (task-3-report.md) proved an unbroken token was silently CLIPPED
  // mid-character (not document overflow — the box's own rect stayed within
  // its container, the text just got cut off with no scrollbar), both
  // inline in the Mudanças tab and inside the decide dialog's `MODAL`.
  // `overflow-wrap: anywhere` is inherited, so one class on the root wraps
  // every field. Static markup can only assert the class; the wrap-vs-clip
  // behavior itself was only checkable in a browser (see the probe
  // screenshots referenced in the report).
  it('carries [overflow-wrap:anywhere] on the root so agent-authored text wraps instead of clipping', () => {
    const markup = renderToStaticMarkup(<AgentArtifactView artifact={makeArtifact()} />);
    const [rootOpenTag] = markup.match(/<section[^>]*>/) ?? [];
    expect(rootOpenTag).toBeDefined();
    expect(rootOpenTag).toContain('overflow-wrap:anywhere');
  });

  it('still renders summary, risks, decisions and next actions', () => {
    const markup = renderToStaticMarkup(
      <AgentArtifactView
        artifact={makeArtifact({
          summary: 'Resumo com token longo.',
          risks: ['Risco um.'],
          decisions: [{ title: 'Escolha', choice: 'A', rationale: 'Porque sim.' }],
          nextActions: ['Próxima ação.'],
        })}
      />,
    );
    expect(markup).toContain('Resumo com token longo.');
    expect(markup).toContain('Risco um.');
    expect(markup).toContain('Escolha: A — Porque sim.');
    expect(markup).toContain('Próxima ação.');
  });
});
