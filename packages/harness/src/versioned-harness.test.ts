import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionedHarnessRepository } from './versioned-harness.js';

const harnessDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../harness');

describe('VersionedHarnessRepository.select', () => {
  it('includes the Supabase stack fragment after nextjs.md for the nextjs stack', async () => {
    const repo = new VersionedHarnessRepository(harnessDir);

    const selection = await repo.select({
      role: 'developer',
      taskKind: 'implementation',
      stack: 'nextjs',
      tags: [],
    });

    const paths = selection.files.map((file) => file.path);
    expect(paths).toContain('stacks/nextjs.md');
    expect(paths).toContain('stacks/supabase.md');
    expect(paths.indexOf('stacks/nextjs.md')).toBeLessThan(paths.indexOf('stacks/supabase.md'));
  });

  it('excludes the Supabase stack fragment for a stack other than nextjs', async () => {
    const repo = new VersionedHarnessRepository(harnessDir);

    const selection = await repo.select({
      role: 'developer',
      taskKind: 'implementation',
      stack: 'other-stack',
      tags: [],
    });

    expect(selection.files.map((file) => file.path)).not.toContain('stacks/supabase.md');
  });
});

describe('VersionedHarnessRepository.scaffoldFiles', () => {
  it('returns the nextjs scaffold files sourced from harness/scaffolds/nextjs', async () => {
    const repo = new VersionedHarnessRepository(harnessDir);

    const files = await repo.scaffoldFiles('nextjs');

    expect(files.map((file) => file.path).sort()).toEqual([
      'app/actions.ts',
      'app/layout.tsx',
      'app/page.tsx',
      'app/sign-in/page.tsx',
      'app/sign-up/page.tsx',
      'lib/supabase/client.ts',
      'lib/supabase/server.ts',
      'middleware.ts',
      'supabase/migrations/00000000000001_rls_baseline_example.sql',
    ]);
    const clientFile = files.find((file) => file.path === 'lib/supabase/client.ts');
    expect(clientFile?.content).toContain('createBrowserClient');
  });

  it('returns an empty array for a stack with no scaffold directory', async () => {
    const repo = new VersionedHarnessRepository(harnessDir);

    await expect(repo.scaffoldFiles('no-such-stack')).resolves.toEqual([]);
  });
});
