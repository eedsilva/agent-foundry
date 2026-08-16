import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Issue #560 (R3): `next dev` runs with cwd apps/web, so @next/env never sees
// the workspace-root .env that `pnpm db:start` writes. scripts/dev.mjs is the
// fix — it loads that .env into the process before spawning both tiers, the
// same load-then-spawn sequence scripts/smoke.mjs already uses. Driven here
// with a stub `pnpm` on PATH, no real workspace or Docker involved.
const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Prints the args and two env vars it received, then exits with
// $STUB_PNPM_EXIT (default 0) — stands in for `pnpm --recursive --parallel
// dev` without starting real dev servers.
const STUB_PNPM = `#!/bin/sh
printf 'pnpm args: %s\\n' "$*"
printf 'VAR_A=%s\\n' "$VAR_A"
printf 'VAR_B=%s\\n' "$VAR_B"
exit "\${STUB_PNPM_EXIT:-0}"
`;

async function devWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-env-'));
  temporaryDirectories.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pnpm'), STUB_PNPM);
  await chmod(join(bin, 'pnpm'), 0o755);

  const workspace = join(dir, 'workspace');
  await mkdir(join(workspace, 'scripts'), { recursive: true });
  await writeFile(
    join(workspace, 'scripts/dev.mjs'),
    await readFile(join(scaffoldRoot, 'scripts/dev.mjs')),
  );
  await chmod(join(workspace, 'scripts/dev.mjs'), 0o755);

  return {
    workspace,
    async writeEnv(contents: string) {
      await writeFile(join(workspace, '.env'), contents);
    },
    run(extraEnv: Record<string, string> = {}) {
      return spawnSync(process.execPath, [join(workspace, 'scripts/dev.mjs')], {
        cwd: workspace,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...extraEnv },
        encoding: 'utf8',
      });
    },
  };
}

describe('the shipped supabase/config.toml', () => {
  it('disables email confirmation explicitly rather than depending on the CLI default', async () => {
    const config = await readFile(join(scaffoldRoot, 'supabase/config.toml'), 'utf8');

    expect(config).toMatch(/\[auth\.email\]\s*\n(?:#.*\n)*enable_confirmations = false/);
  });
});

describe('scripts/dev.mjs', () => {
  it('loads the workspace-root .env into the spawned dev servers', async () => {
    const project = await devWorkspace();
    await project.writeEnv('VAR_A=from-env-file\nVAR_B=also-from-file\n');

    const result = project.run();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pnpm args: --recursive --parallel dev');
    expect(result.stdout).toContain('VAR_A=from-env-file');
    expect(result.stdout).toContain('VAR_B=also-from-file');
  });

  // The platform's credential bridge (ADR 0034) injects the real Supabase
  // credentials into this process's env before pnpm dev runs. A stale
  // workspace .env must never overwrite them — this is the case that
  // protects that bridge, so it is not optional.
  it('keeps a value already present in the environment over the same key in .env', async () => {
    const project = await devWorkspace();
    await project.writeEnv('VAR_A=from-env-file\n');

    const result = project.run({ VAR_A: 'injected-value' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VAR_A=injected-value');
    expect(result.stdout).not.toContain('VAR_A=from-env-file');
  });

  it('forwards the spawned dev servers exit code', async () => {
    const project = await devWorkspace();
    await project.writeEnv('VAR_A=x\n');

    const result = project.run({ STUB_PNPM_EXIT: '7' });

    expect(result.status).toBe(7);
  });
});
