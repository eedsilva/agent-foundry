import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-server-actions.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(resolve('/tmp'), 'scaffold-server-actions-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-server-actions.mjs'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-server-actions.mjs')], {
    encoding: 'utf8',
  });
}

describe('check-server-actions build gate', () => {
  it('passes on the shipped scaffold', () => {
    const result = runCheck(scaffoldRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails a use-server module that exports non-functions', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/appointment-actions.ts':
        "'use server';\nexport const initialState = {};\nexport async function create() {}\n",
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/app/appointment-actions.ts:2');
    expect(result.stderr).toContain('only export async functions');
  });

  it('allows type exports and async server actions', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/actions.ts':
        "'use server';\nexport type State = { error: string | null };\nexport async function create() {}\n",
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('ignores installed and built directories', async () => {
    const workspace = await workspaceWith({
      'apps/web/node_modules/example/action.ts': "'use server';\nexport const invalid = {};\n",
      'apps/web/.next/server/action.js': "'use server';\nexport const invalid = {};\n",
      'apps/web/dist/action.js': "'use server';\nexport const invalid = {};\n",
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
