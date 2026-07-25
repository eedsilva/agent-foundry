import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatTile } from './stat-tile';

describe('StatTile', () => {
  it('renders label, value and hint', () => {
    const markup = renderToStaticMarkup(
      <StatTile label="Decisões" value={42} hint="últimos 7 dias" />,
    );
    expect(markup).toContain('Decisões');
    expect(markup).toContain('42');
    expect(markup).toContain('últimos 7 dias');
  });

  it('is a solid card, never glass', () => {
    const markup = renderToStaticMarkup(<StatTile label="x" value="1" />);
    expect(markup).not.toMatch(/\bglass\b/);
  });

  it('keeps the value in --ink and carries the tone on a non-text border', () => {
    const markup = renderToStaticMarkup(<StatTile label="x" value="1" tone="ok" />);
    // `--ok` as text on white is 2.55:1; DESIGN.md §7 requires 4.5:1.
    expect(markup).not.toContain('text-ok');
    expect(markup).toContain('border-l-ok');
  });

  it('keeps the hint above 4.5:1', () => {
    // `--ink-subtle` is 2.98:1 on `--surface`; `--ink-muted` is 5.47:1.
    const markup = renderToStaticMarkup(<StatTile label="x" value="1" hint="y" />);
    expect(markup).not.toContain('text-ink-subtle');
  });
});
