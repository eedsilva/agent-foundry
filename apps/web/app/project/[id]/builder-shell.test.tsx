import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuilderGate, BuilderShell } from './builder-shell';

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

  it('omits the inspector pane entirely when showInspector is false', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell
        header={null}
        alerts={null}
        chat={<section role="region" aria-label="Chat" />}
        center={<section role="region" aria-label="Preview" />}
        inspector={<section role="region" aria-label="Changes" />}
        showInspector={false}
      />,
    );
    expect(markup).toContain('data-testid="pane-chat"');
    expect(markup).toContain('data-testid="pane-center"');
    expect(markup).not.toContain('data-testid="pane-inspector"');
    expect(markup).not.toContain('aria-label="Changes"');
  });

  it('still renders the inspector pane when showInspector is omitted (defaults true)', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell
        header={null}
        alerts={null}
        chat={null}
        center={null}
        inspector={<section role="region" aria-label="Changes" />}
      />,
    );
    expect(markup).toContain('data-testid="pane-inspector"');
  });
});

describe('BuilderGate', () => {
  it('announces the pre-detail wait as a busy live region, not bare muted text', () => {
    const markup = renderToStaticMarkup(<BuilderGate error="" onRetry={() => undefined} />);
    expect(markup).toContain('data-kind="loading"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('Carregando execução…');
  });

  it('renders a failed project load as an alert with a retry action, not as loading', () => {
    const markup = renderToStaticMarkup(
      <BuilderGate error="projeto indisponível" onRetry={() => undefined} />,
    );
    expect(markup).toContain('data-kind="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('projeto indisponível');
    expect(markup).toContain('Tentar novamente');
    expect(markup).not.toContain('data-kind="loading"');
    expect(markup).not.toContain('Carregando execução…');
  });
});
