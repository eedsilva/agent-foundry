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

  // #97 task 3: a narrow-viewport Playwright probe (390px, see
  // task-3-report.md) found this bar — rendered on every page via
  // layout.tsx — pushed the document 102px past the viewport at 390px: the
  // logo, nav and RuntimePill never wrapped and the bar had a fixed `h-14`.
  // `flex-wrap` plus `min-h-14` (in place of a fixed height) let it grow to
  // a second row instead. Static markup can only assert the classes; the
  // no-overflow claim itself was verified in the probe, not here.
  it('wraps instead of forcing a fixed-height overflow at narrow widths', () => {
    const markup = renderToStaticMarkup(<TopBar activePath="/" />);
    const [headerOpenTag] = markup.match(/<header[^>]*>/) ?? [];
    expect(headerOpenTag).toBeDefined();
    const classAttr = headerOpenTag?.match(/class="([^"]*)"/)?.[1] ?? '';
    const classes = classAttr.split(/\s+/);
    expect(classes).toContain('flex-wrap');
    expect(classes).toContain('min-h-14');
    // Not the fixed-height utility this replaces — `min-h-14` alone also
    // contains the substring "h-14", so this checks the exact token list
    // rather than a substring/regex match.
    expect(classes).not.toContain('h-14');
  });
});
