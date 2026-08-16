import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-route-handlers.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-route-handlers-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-route-handlers.mjs'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-route-handlers.mjs')], {
    encoding: 'utf8',
  });
}

describe('check-route-handlers build gate', () => {
  it('passes on the shipped scaffold', () => {
    const result = runCheck(scaffoldRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails a route module with a default export', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/route.ts': 'export default function handler() {}\n',
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/app/api/x/route.ts:1');
    expect(result.stderr).toContain('export default');
  });

  it('fails a route module that exports no HTTP method', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/route.ts': 'export const revalidate = 60;\nexport type Payload = {};\n',
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/app/api/x/route.ts');
    expect(result.stderr).toContain('no HTTP method');
  });

  it('fails a route module that re-exports a whole module', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/route.ts': "export async function GET() {}\nexport * from './helpers';\n",
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/app/api/x/route.ts:2');
    expect(result.stderr).toContain('export *');
  });

  it('fails a route module that exports a value outside the allowlist', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/route.ts':
        "export async function GET() {}\nexport const config = { runtime: 'edge' };\n",
    });

    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/app/api/x/route.ts:2');
    expect(result.stderr).toContain('config');
  });

  it('allows route segment config beside an HTTP method', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/route.ts':
        'export const revalidate = 60;\nexport async function GET() {}\n',
      'apps/web/app/api/y/route.ts':
        "export const dynamic = 'force-dynamic';\nexport async function GET() {}\n",
      'apps/web/app/api/z/route.ts':
        'export type Payload = { id: string };\nexport async function GET() {}\n',
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('ignores the same export in a file that is not a route module', async () => {
    const workspace = await workspaceWith({
      'apps/web/app/api/x/helpers.ts': 'export default function helper() {}\n',
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('ignores installed and built directories', async () => {
    const workspace = await workspaceWith({
      'apps/web/node_modules/example/app/route.ts': 'export default function handler() {}\n',
      'apps/web/.next/server/app/route.js': 'export default function handler() {}\n',
      'apps/web/dist/app/route.js': 'export default function handler() {}\n',
    });

    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
