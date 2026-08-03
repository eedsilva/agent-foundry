import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopBar } from './top-bar';

describe('TopBar', () => {
  it('links to all navigation surfaces and marks the active one', () => {
    const markup = renderToStaticMarkup(<TopBar activePath="/router" />);
    expect(markup).toContain('href="/"');
    expect(markup).toContain('href="/router"');
    expect(markup).toContain('href="/validation"');
    expect(markup).toContain('Projetos');
    expect(markup).toContain('Router');
    expect(markup).toContain('Validação');
    expect(markup).toContain('aria-current="page"');
  });

  it('is a glass surface, not a solid card', () => {
    const markup = renderToStaticMarkup(<TopBar activePath="/" />);
    expect(markup).toMatch(/class="[^"]*\bglass\b/);
  });
});
