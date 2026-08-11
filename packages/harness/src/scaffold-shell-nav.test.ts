import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

describe('UI primitives and shell/nav', () => {
  it('components/ui/button.tsx exports Button', async () => {
    const buttonTsx = await readFile(
      resolve(scaffoldRoot, 'apps/web/components/ui/button.tsx'),
      'utf8',
    );

    expect(buttonTsx).toContain('export function Button');
  });

  it('components/ui/skeleton.tsx exports Skeleton', async () => {
    const skeletonTsx = await readFile(
      resolve(scaffoldRoot, 'apps/web/components/ui/skeleton.tsx'),
      'utf8',
    );

    expect(skeletonTsx).toContain('export function Skeleton');
  });

  it('components/nav.tsx exports Nav', async () => {
    const navTsx = await readFile(resolve(scaffoldRoot, 'apps/web/components/nav.tsx'), 'utf8');

    expect(navTsx).toContain('export function Nav');
  });

  it('components/shell.tsx exports Shell and imports Nav', async () => {
    const shellTsx = await readFile(resolve(scaffoldRoot, 'apps/web/components/shell.tsx'), 'utf8');

    expect(shellTsx).toContain('export function Shell');
    expect(shellTsx).toContain('Nav');
  });

  it('app/layout.tsx imports and renders Shell', async () => {
    const layoutTsx = await readFile(resolve(scaffoldRoot, 'apps/web/app/layout.tsx'), 'utf8');

    expect(layoutTsx).toContain("from '../components/shell'");
    expect(layoutTsx).toContain('<Shell>');
  });
});
