import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

describe('shadcn/ui foundation — tokens and utils', () => {
  it('components.json parses as JSON with correct tailwind config', async () => {
    const componentsJson = JSON.parse(
      await readFile(resolve(scaffoldRoot, 'apps/web/components.json'), 'utf8'),
    ) as {
      tailwind?: { cssVariables?: boolean };
      aliases?: Record<string, string>;
    };

    expect(componentsJson.tailwind?.cssVariables).toBe(true);
    expect(componentsJson.aliases?.ui).toBe('@/components/ui');
  });

  it('globals.css contains theme tokens and @theme inline', async () => {
    const globalsCSS = await readFile(resolve(scaffoldRoot, 'apps/web/app/globals.css'), 'utf8');

    expect(globalsCSS).toContain('--background');
    expect(globalsCSS).toContain('--foreground');
    expect(globalsCSS).toContain('@theme inline');
  });

  it('lib/utils.ts exports cn function', async () => {
    const utilsTs = await readFile(resolve(scaffoldRoot, 'apps/web/lib/utils.ts'), 'utf8');

    expect(utilsTs).toContain('export function cn');
  });

  it('package.json includes clsx and tailwind-merge dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(scaffoldRoot, 'apps/web/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).toMatchObject({
      clsx: expect.any(String),
      'tailwind-merge': expect.any(String),
    });
  });
});
