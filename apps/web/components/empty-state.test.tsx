import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title, hint and action', () => {
    const markup = renderToStaticMarkup(
      <EmptyState
        title="Nada aqui"
        hint="Tente outro filtro."
        action={<button>Recarregar</button>}
      />,
    );
    expect(markup).toContain('Nada aqui');
    expect(markup).toContain('Tente outro filtro.');
    expect(markup).toContain('Recarregar');
  });

  it('keeps the hint above 4.5:1 on the sunken wash', () => {
    // `--ink-subtle` on `--surface-sunken` is 2.63:1; `--ink-muted` is 4.82:1.
    const markup = renderToStaticMarkup(<EmptyState title="x" hint="y" />);
    expect(markup).not.toContain('text-ink-subtle');
    expect(markup).toContain('text-ink-muted');
  });
});
