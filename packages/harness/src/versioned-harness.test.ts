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
