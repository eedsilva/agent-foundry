import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectPackageManager, scriptCommand } from './package-manager.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-foundry-pm-'));
  temporaryDirectories.push(dir);
  return dir;
}

describe('detectPackageManager', () => {
  it('detects npm by package-lock.json', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'a' }));
    await writeFile(join(dir, 'package-lock.json'), '{}');
    expect(await detectPackageManager(dir)).toBe('npm');
  });

  it('detects pnpm by pnpm-lock.yaml', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('detects yarn by yarn.lock', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'yarn.lock'), '');
    expect(await detectPackageManager(dir)).toBe('yarn');
  });

  it('detects bun by bun.lock', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'bun.lock'), '');
    expect(await detectPackageManager(dir)).toBe('bun');
  });

  it('returns unknown when no lockfile or packageManager field is found', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'a' }));
    expect(await detectPackageManager(dir)).toBe('unknown');
  });

  it('prefers the corepack packageManager field over a lockfile', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package-lock.json'), '{}');
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', packageManager: 'pnpm@8.15.4' }),
    );
    expect(await detectPackageManager(dir)).toBe('pnpm');
  });

  it('walks up to the repository root to resolve a monorepo workspace lockfile', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.git'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
    );
    await writeFile(join(root, 'package-lock.json'), '{}');
    const appDir = join(root, 'apps', 'web');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { dev: 'next dev' } }),
    );
    expect(await detectPackageManager(appDir)).toBe('npm');
  });

  it('stops at the repository root and does not see lockfiles above it', async () => {
    const outer = await tempDir();
    await writeFile(join(outer, 'pnpm-lock.yaml'), '');
    const root = join(outer, 'project');
    await mkdir(root);
    await mkdir(join(root, '.git'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root' }));
    expect(await detectPackageManager(root)).toBe('unknown');
  });
});

describe('scriptCommand', () => {
  it("shapes each package manager's run invocation", () => {
    expect(scriptCommand('npm', 'build')).toEqual({ command: 'npm', args: ['run', 'build'] });
    expect(scriptCommand('pnpm', 'build')).toEqual({ command: 'pnpm', args: ['run', 'build'] });
    expect(scriptCommand('yarn', 'build')).toEqual({ command: 'yarn', args: ['build'] });
    expect(scriptCommand('bun', 'build')).toEqual({ command: 'bun', args: ['run', 'build'] });
  });
});
