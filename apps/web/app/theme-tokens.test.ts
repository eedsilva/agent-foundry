import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/app/theme.css'), 'utf8');

const TOKENS: Record<string, string> = {
  '--color-bg': '#f4f6f8',
  '--color-ink': '#10151a',
  '--color-ink-muted': '#5c6b7a',
  '--color-ink-subtle': '#656e77',
  '--color-surface': '#ffffff',
  '--color-surface-sunken': '#eef1f4',
  '--color-hairline': 'rgba(16, 21, 26, 0.08)',
  '--color-accent': '#0fa3a3',
  '--color-accent-strong': '#0c8080',
  '--color-accent-wash': 'rgba(15, 163, 163, 0.08)',
  '--color-ok': '#1fa971',
  '--color-warn': '#e8a33d',
  '--color-err': '#e5484d',
  '--color-info': '#3e7bfa',
};

describe('theme.css', () => {
  it('imports tailwind', () => {
    expect(css).toMatch(/@import\s+['"]tailwindcss['"]/);
  });

  it('declares every design token from DESIGN.md with the specified value', () => {
    for (const [token, value] of Object.entries(TOKENS)) {
      expect(css.toLowerCase()).toContain(`${token}: ${value}`);
    }
  });

  it('declares the glass recipe', () => {
    expect(css).toMatch(/--glass-blur:\s*24px/);
    expect(css).toMatch(/--glass:\s*rgba\(255,\s*255,\s*255,\s*0?\.6\)/);
    expect(css).toMatch(/--glass-stroke:\s*rgba\(255,\s*255,\s*255,\s*0?\.72\)/);
  });

  it('declares purposeful motion primitives with reduced-motion support', () => {
    expect(css).toContain('--ease-out: cubic-bezier(0.23, 1, 0.32, 1)');
    expect(css).toContain('.motion-state-enter');
    expect(css).toContain('.overlay-surface');
    expect(css).toContain('.status-dot-live');
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('has no dark theme branch', () => {
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).not.toMatch(/\.dark\s*\{/);
  });
});
