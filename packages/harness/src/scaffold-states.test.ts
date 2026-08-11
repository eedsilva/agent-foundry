import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

describe('empty/loading/error state components', () => {
  it('components/empty-state.tsx exports EmptyState', async () => {
    const emptyStateTsx = await readFile(
      resolve(scaffoldRoot, 'apps/web/components/empty-state.tsx'),
      'utf8',
    );

    expect(emptyStateTsx).toContain('export function EmptyState');
  });

  it('components/loading-state.tsx exports LoadingState', async () => {
    const loadingStateTsx = await readFile(
      resolve(scaffoldRoot, 'apps/web/components/loading-state.tsx'),
      'utf8',
    );

    expect(loadingStateTsx).toContain('export function LoadingState');
  });

  it('components/error-state.tsx exports ErrorState', async () => {
    const errorStateTsx = await readFile(
      resolve(scaffoldRoot, 'apps/web/components/error-state.tsx'),
      'utf8',
    );

    expect(errorStateTsx).toContain('export function ErrorState');
  });

  it('app/page.tsx imports EmptyState and no longer uses the old inline empty-state string', async () => {
    const pageTsx = await readFile(resolve(scaffoldRoot, 'apps/web/app/page.tsx'), 'utf8');

    expect(pageTsx).toContain("from '../components/empty-state'");
    expect(pageTsx).toContain('<EmptyState');
    // The shared `text-sm text-gray-600` class also styles the unrelated
    // session.user.email paragraph, which this task must not touch. Assert
    // against the specific dead markup instead of the ambiguous class string.
    expect(pageTsx).not.toContain('text-sm text-gray-600">No items yet.');
  });
});
