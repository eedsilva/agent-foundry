import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PackageManager } from '@agent-foundry/contracts';

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

const KNOWN_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Detects the package manager for a workspace. The `packageManager` corepack
 * field on the nearest package.json wins over lockfile presence. Both checks
 * walk from `workspacePath` up to the repository root (marked by `.git`, checked
 * inclusively) so a nested monorepo package resolves to its root lockfile.
 */
export async function detectPackageManager(workspacePath: string): Promise<PackageManager> {
  let dir = workspacePath;
  for (;;) {
    const packageJson = await readPackageJsonAt(dir);
    const declared = packageJson ? corepackPackageManager(packageJson) : undefined;
    if (declared) return declared;
    for (const [file, manager] of LOCKFILES) {
      if (await pathExists(join(dir, file))) return manager;
    }
    if (await pathExists(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

/** Shapes a package.json script invocation per package manager (yarn omits "run"). */
export function scriptCommand(
  packageManager: PackageManager,
  script: string,
): { command: string; args: string[] } {
  switch (packageManager) {
    case 'pnpm':
      return { command: 'pnpm', args: ['run', script] };
    case 'yarn':
      return { command: 'yarn', args: [script] };
    case 'bun':
      return { command: 'bun', args: ['run', script] };
    case 'npm':
    case 'unknown':
      return { command: 'npm', args: ['run', script] };
  }
}

function corepackPackageManager(packageJson: Record<string, unknown>): PackageManager | undefined {
  const value = packageJson.packageManager;
  if (typeof value !== 'string') return undefined;
  const name = value.split('@')[0] ?? '';
  return KNOWN_MANAGERS.has(name) ? (name as PackageManager) : undefined;
}

async function readPackageJsonAt(dir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
