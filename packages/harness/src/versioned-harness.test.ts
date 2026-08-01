import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
      '.env.example',
      '.prettierignore',
      'README.md',
      'apps/api/package.json',
      'apps/api/src/database.types.ts',
      'apps/api/src/env.ts',
      'apps/api/src/server.ts',
      'apps/api/src/supabase.ts',
      'apps/api/tsconfig.json',
      'apps/web/app/actions.ts',
      'apps/web/app/globals.css',
      'apps/web/app/layout.tsx',
      'apps/web/app/page.tsx',
      'apps/web/app/sign-in/page.tsx',
      'apps/web/app/sign-up/page.tsx',
      'apps/web/app/submit-button.tsx',
      'apps/web/lib/supabase/server.ts',
      'apps/web/middleware.ts',
      'apps/web/next.config.ts',
      'apps/web/package.json',
      'apps/web/postcss.config.mjs',
      'apps/web/tsconfig.json',
      'browser-tests/cross-tenant-denial.json',
      'eslint.config.mjs',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'prettier.config.mjs',
      'scripts/check-server-actions.mjs',
      'scripts/check-service-role.mjs',
      'scripts/db.mjs',
      'scripts/smoke.mjs',
      'supabase/config.toml',
      'supabase/migrations/20260726000000_rls_baseline.sql',
      'supabase/seed.sql',
    ]);
    const serverClient = files.find((file) => file.path === 'apps/web/lib/supabase/server.ts');
    expect(serverClient?.content).toContain('createServerClient');
  });

  it('leaves behind what a local install and run of the scaffold produces', async () => {
    // A throwaway harness dir rather than the real one: the point is what a
    // developer's `pnpm install && pnpm dev` leaves in the scaffold, and this
    // test should not have to create and clean that up in the checkout.
    const fakeHarness = await mkdtemp(join(tmpdir(), 'harness-scaffold-'));
    const scaffoldRoot = join(fakeHarness, 'scaffolds/demo');
    await mkdir(join(scaffoldRoot, 'apps/api'), { recursive: true });
    await mkdir(join(scaffoldRoot, 'apps/web/node_modules/next'), { recursive: true });
    await mkdir(join(scaffoldRoot, 'apps/web/.next/server'), { recursive: true });
    await mkdir(join(scaffoldRoot, 'supabase/.temp'), { recursive: true });
    await Promise.all([
      writeFile(join(scaffoldRoot, 'package.json'), '{}\n'),
      writeFile(join(scaffoldRoot, '.env.example'), 'NEXT_PUBLIC_SUPABASE_URL=\n'),
      writeFile(join(scaffoldRoot, '.env'), 'SUPABASE_SERVICE_ROLE_KEY=real-secret\n'),
      writeFile(join(scaffoldRoot, 'apps/api/tsconfig.tsbuildinfo'), '{}\n'),
      writeFile(join(scaffoldRoot, 'apps/web/node_modules/next/index.js'), 'export {};\n'),
      writeFile(join(scaffoldRoot, 'apps/web/.next/server/page.js'), 'export {};\n'),
      writeFile(join(scaffoldRoot, 'supabase/.temp/cli-latest'), 'v2.62.5\n'),
    ]);

    try {
      const files = await new VersionedHarnessRepository(fakeHarness).scaffoldFiles('demo');

      expect(files.map((file) => file.path)).toEqual(['.env.example', 'package.json']);
    } finally {
      await rm(fakeHarness, { recursive: true, force: true });
    }
  });

  it('returns an empty array for a stack with no scaffold directory', async () => {
    const repo = new VersionedHarnessRepository(harnessDir);

    await expect(repo.scaffoldFiles('no-such-stack')).resolves.toEqual([]);
  });
});
