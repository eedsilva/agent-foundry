import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaneState } from './pane-state';

describe('PaneState', () => {
  it('kind="empty" renders title, hint and action with no live-region role', () => {
    const markup = renderToStaticMarkup(
      <PaneState
        kind="empty"
        title="Nada aqui"
        hint="Tente outro filtro."
        action={<button>Recarregar</button>}
      />,
    );
    expect(markup).toContain('Nada aqui');
    expect(markup).toContain('Tente outro filtro.');
    expect(markup).toContain('Recarregar');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('data-testid="pane-state"');
    expect(markup).toContain('data-kind="empty"');
  });

  it('keeps the hint above 4.5:1 on the sunken wash', () => {
    // `--ink-subtle` on `--surface-sunken` is 2.63:1; `--ink-muted` is 4.82:1.
    const markup = renderToStaticMarkup(<PaneState kind="empty" title="x" hint="y" />);
    expect(markup).not.toContain('text-ink-subtle');
    expect(markup).toContain('text-ink-muted');
  });

  it('kind="loading" adds role="status" and aria-busy="true"', () => {
    const markup = renderToStaticMarkup(<PaneState kind="loading" title="Carregando…" />);
    expect(markup).toContain('data-kind="loading"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-busy="true"');
  });

  it('kind="error" adds role="alert" and renders on the err tone wash', () => {
    const markup = renderToStaticMarkup(<PaneState kind="error" title="Falhou." />);
    expect(markup).toContain('data-kind="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('bg-err/10');
    expect(markup).toContain('border-err/30');
    // `--ink`, not `--err`, carries the text — see ERROR_BOX in lib/ui.ts.
    expect(markup).not.toContain('text-err');
  });
});
