import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuilderShell } from './builder-shell';

describe('BuilderShell', () => {
  it('keeps Chat, Preview and Changes landmarks in document order', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell
        header={<div />}
        alerts={null}
        chat={<section role="region" aria-label="Chat" />}
        center={<section role="region" aria-label="Preview" />}
        inspector={<section role="region" aria-label="Changes" />}
      />,
    );

    expect(
      [...markup.matchAll(/aria-label="(Chat|Preview|Changes)"/g)].map((match) => match[1]),
    ).toEqual(['Chat', 'Preview', 'Changes']);
  });

  it('exposes the three panes by testid', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell header={null} alerts={null} chat={null} center={null} inspector={null} />,
    );
    expect(markup).toContain('data-testid="pane-chat"');
    expect(markup).toContain('data-testid="pane-center"');
    expect(markup).toContain('data-testid="pane-inspector"');
  });
});
