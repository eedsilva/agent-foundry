import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-build-output.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWith(
  files: Record<string, string>,
  directories: string[] = [],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-build-output-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-build-output.mjs'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  for (const path of directories) await mkdir(join(dir, path), { recursive: true });
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-build-output.mjs')], {
    encoding: 'utf8',
  });
}

const nextPackage = JSON.stringify({
  name: 'web',
  scripts: { build: 'next build' },
  dependencies: { next: '^16.2.11' },
});
const tscPackage = JSON.stringify({ name: 'api', scripts: { build: 'tsc -p tsconfig.json' } });

describe('check-build-output build gate', () => {
  it('fails a Next package that produced no BUILD_ID', async () => {
    const workspace = await workspaceWith({ 'apps/web/package.json': nextPackage });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/.next/BUILD_ID');
  });

  it('fails a Next package whose BUILD_ID is empty', async () => {
    const workspace = await workspaceWith({
      'apps/web/package.json': nextPackage,
      'apps/web/.next/BUILD_ID': '  \n',
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/.next/BUILD_ID');
  });

  it('passes and prints the build id', async () => {
    const workspace = await workspaceWith({
      'apps/web/package.json': nextPackage,
      'apps/web/.next/BUILD_ID': 'kL3xQ9\n',
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('kL3xQ9');
  });

  it('fails a non-Next package whose output directory is empty or missing', async () => {
    const workspace = await workspaceWith(
      {
        'apps/api/package.json': tscPackage,
        'apps/api/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
        'apps/jobs/package.json': tscPackage,
        'apps/jobs/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
      },
      ['apps/api/dist'],
    );

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/api/dist');
    expect(result.stderr).toContain('apps/jobs/dist');
  });

  it('ignores a package that declares no build script', async () => {
    const workspace = await workspaceWith({
      'apps/docs/package.json': JSON.stringify({ name: 'docs', scripts: { lint: 'eslint .' } }),
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('covers a workspace package outside apps/', async () => {
    // The workspace glob starts at `apps/*` and a generated app may add
    // `packages/*`; assuming `apps/` would stop covering it, silently.
    const workspace = await workspaceWith({
      'packages/core/package.json': tscPackage,
      'packages/core/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'dist' } }),
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('packages/core/dist');
  });

  it('does not descend into an installed dependency', async () => {
    const workspace = await workspaceWith({
      'apps/web/package.json': nextPackage,
      'apps/web/.next/BUILD_ID': 'kL3xQ9\n',
      'apps/web/node_modules/left-pad/package.json': JSON.stringify({
        name: 'left-pad',
        scripts: { build: 'tsc' },
      }),
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('honours a custom outDir from tsconfig', async () => {
    const workspace = await workspaceWith({
      'apps/api/package.json': tscPackage,
      'apps/api/tsconfig.json': JSON.stringify({ compilerOptions: { outDir: 'build/out' } }),
      'apps/api/build/out/server.js': 'export {};\n',
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('apps/api/build/out');
  });
});
