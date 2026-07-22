import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/app/globals.css'), 'utf8');

describe('builder shell responsive CSS', () => {
  it('collapses before the three fixed minimum tracks can overflow', () => {
    expect(css).toMatch(
      /@media \(max-width: 1000px\)[\s\S]*?\.builderGrid\s*{\s*grid-template-columns: 1fr;/,
    );
  });

  it('bounds long diff lines to horizontal scrolling inside the panel', () => {
    expect(css).toMatch(/\.diffPane\s*{[^}]*max-width: 100%;[^}]*overflow-x: auto;/s);
  });
});
