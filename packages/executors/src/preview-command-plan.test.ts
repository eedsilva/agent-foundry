import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectPolicySchema } from '@agent-foundry/contracts';
import { resolvePreviewCommandPlan, runReproducibleInstall } from './preview-command-plan.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-plan-'));
  temporaryDirectories.push(dir);
  return dir;
}

describe('resolvePreviewCommandPlan', () => {
  it('plans a Next.js workspace with npm', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'nextjs-app',
        dependencies: { next: '15.0.0' },
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
      }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');

    const plan = await resolvePreviewCommandPlan(dir);

    expect(plan.packageManager).toBe('npm');
    expect(plan.install).toEqual({ ok: true, command: 'npm', args: ['ci'] });
    expect(plan.build).toEqual({ ok: true, command: 'npm', args: ['run', 'build'] });
    expect(plan.dev).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] });
  });

  it('plans a Vite workspace with pnpm', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'vite-app',
        devDependencies: { vite: '6.0.0' },
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      }),
    );
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');

    const plan = await resolvePreviewCommandPlan(dir);

    expect(plan.packageManager).toBe('pnpm');
    expect(plan.install).toEqual({
      ok: true,
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    });
    expect(plan.build).toEqual({ ok: true, command: 'pnpm', args: ['run', 'build'] });
    expect(plan.dev).toEqual({ ok: true, command: 'pnpm', args: ['run', 'dev'] });
  });

  it('resolves the root package manager for a nested npm workspaces package', async () => {
    const root = await tempDir();
    await mkdir(join(root, '.git'));
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['apps/*'] }),
    );
    await writeFile(join(root, 'package-lock.json'), '{}');
    const appDir = join(root, 'apps', 'web');
    await mkdir(appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { dev: 'next dev', build: 'next build' } }),
    );

    const plan = await resolvePreviewCommandPlan(appDir);

    expect(plan.packageManager).toBe('npm');
    expect(plan.install).toEqual({ ok: true, command: 'npm', args: ['ci'] });
    expect(plan.dev).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] });
  });

  it('falls back from dev to start when no dev script exists', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', scripts: { start: 'node server.js', build: 'tsc' } }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');

    const plan = await resolvePreviewCommandPlan(dir);

    expect(plan.dev).toEqual({ ok: true, command: 'npm', args: ['run', 'start'] });
  });

  it('returns a diagnostic when the build script is missing, not a guessed command', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', scripts: { dev: 'vite' } }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');

    const plan = await resolvePreviewCommandPlan(dir);

    expect(plan.build).toEqual({
      ok: false,
      reason: "package.json is missing a 'build' script required for build.",
    });
  });

  it('returns a diagnostic for install when no package manager can be detected', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.git'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', scripts: { dev: 'vite', build: 'vite build' } }),
    );

    const plan = await resolvePreviewCommandPlan(dir);

    expect(plan.packageManager).toBe('unknown');
    expect(plan.install.ok).toBe(false);
  });

  it('overrides the build script name from policy.previewCommands', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', scripts: { dev: 'vite', compile: 'vite build' } }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'custom',
      version: 1,
      previewCommands: { build: 'compile' },
    });

    const plan = await resolvePreviewCommandPlan(dir, policy);

    expect(plan.build).toEqual({ ok: true, command: 'npm', args: ['run', 'compile'] });
  });

  it('blocks a script outside the policy allowlist with a diagnostic', async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', scripts: { dev: 'vite', build: 'vite build' } }),
    );
    await writeFile(join(dir, 'package-lock.json'), '{}');
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'strict',
      version: 1,
      allowedCommands: ['dev'],
    });

    const plan = await resolvePreviewCommandPlan(dir, policy);

    expect(plan.build).toEqual({
      ok: false,
      reason: "Script 'build' is not allowed by policy strict@v1.",
    });
    expect(plan.dev).toEqual({ ok: true, command: 'npm', args: ['run', 'dev'] });
  });
});

describe('runReproducibleInstall', () => {
  it('succeeds with npm ci when the lockfile matches package.json', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
    await execa('npm', ['install', '--package-lock-only'], { cwd: dir });

    const plan = await resolvePreviewCommandPlan(dir);
    const outcome = await runReproducibleInstall(plan, dir, {
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.versions?.node).toBe(process.version);
  }, 30_000);

  it('fails when the lockfile diverges from package.json', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }));
    await execa('npm', ['install', '--package-lock-only'], { cwd: dir });
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { 'left-pad': '1.3.0' } }),
    );

    const plan = await resolvePreviewCommandPlan(dir);
    const outcome = await runReproducibleInstall(plan, dir, {
      timeoutMs: 30_000,
      maxOutputBytes: 1_000_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).not.toBe(0);
  }, 30_000);

  it('returns a diagnostic without executing anything when the plan has no install command', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, '.git'));
    const plan = await resolvePreviewCommandPlan(dir);

    const outcome = await runReproducibleInstall(plan, dir, {
      timeoutMs: 5_000,
      maxOutputBytes: 1_000_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.stderr).toContain('cannot pick a reproducible install command');
  });
});
