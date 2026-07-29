import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

describe('generated Next.js scaffold tooling', () => {
  it('declares lint, test, format, and lint-fix entry points', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(scaffoldRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      lint: expect.any(String),
      test: expect.any(String),
      format: expect.any(String),
      'lint:fix': expect.any(String),
    });
  });

  it('ships the lint configuration and formatter dependencies', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(scaffoldRoot, 'package.json'), 'utf8'),
    ) as { devDependencies?: Record<string, string> };
    const lockfile = await readFile(resolve(scaffoldRoot, 'pnpm-lock.yaml'), 'utf8');

    expect(await readFile(resolve(scaffoldRoot, 'eslint.config.mjs'), 'utf8')).toContain(
      'typescript-eslint',
    );
    expect(packageJson.devDependencies).toMatchObject({
      eslint: expect.any(String),
      prettier: expect.any(String),
    });
    expect(lockfile).toContain('eslint:');
    expect(lockfile).toContain('prettier@');
  });
});
