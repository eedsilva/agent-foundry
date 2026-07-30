import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

function runPackageScript(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, args, { cwd, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
}

describe('generated Next.js scaffold tooling', () => {
  it('declares lint, test, format, and lint-fix entry points', async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(scaffoldRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      lint: 'eslint . --max-warnings=0',
      'lint:fix': 'eslint . --fix',
      format: 'prettier --write .',
      'format:check': 'prettier --check .',
      test: 'node --test',
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

  it('executes failing checks and runs the formatter/lint autofix commands', async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), 'agent-foundry-scaffold-tooling-'));
    const bin = resolve(cwd, 'node_modules/.bin');
    try {
      const packageJson = JSON.parse(
        await readFile(resolve(scaffoldRoot, 'package.json'), 'utf8'),
      ) as { scripts: Record<string, string> };
      await writeFile(
        resolve(cwd, 'package.json'),
        JSON.stringify({
          private: true,
          type: 'module',
          scripts: Object.fromEntries(
            ['lint', 'lint:fix', 'format', 'format:check', 'test'].map((name) => [
              name,
              packageJson.scripts[name],
            ]),
          ),
        }),
      );
      await mkdir(bin, { recursive: true });
      await writeFile(resolve(cwd, 'invalid.txt'), 'invalid');
      await writeFile(
        resolve(cwd, 'broken.test.js'),
        "import { test } from 'node:test'; test('broken', () => { throw new Error('broken'); });",
      );
      await writeFile(
        resolve(bin, 'eslint'),
        `#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
const fix = process.argv.includes('--fix');
if (fix) rmSync('invalid.txt', { force: true });
process.exit(fix || !existsSync('invalid.txt') ? 0 : 1);
`,
      );
      await writeFile(
        resolve(bin, 'prettier'),
        `#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
const fix = process.argv.includes('--write');
if (fix) rmSync('invalid.txt', { force: true });
process.exit(process.argv.includes('--check') && existsSync('invalid.txt') ? 1 : 0);
`,
      );
      await chmod(resolve(bin, 'eslint'), 0o755);
      await chmod(resolve(bin, 'prettier'), 0o755);

      expect(await runPackageScript(cwd, ['run', 'lint'])).toBe(1);
      expect(await runPackageScript(cwd, ['test'])).toBe(1);

      await rm(resolve(cwd, 'broken.test.js'));
      expect(await runPackageScript(cwd, ['run', 'format'])).toBe(0);
      expect(await runPackageScript(cwd, ['run', 'format:check'])).toBe(0);
      await writeFile(resolve(cwd, 'invalid.txt'), 'invalid');
      expect(await runPackageScript(cwd, ['run', 'lint:fix'])).toBe(0);
      expect(await runPackageScript(cwd, ['run', 'lint'])).toBe(0);
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});
