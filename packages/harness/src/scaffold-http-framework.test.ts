import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-http-framework.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-http-framework-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-http-framework.mjs'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-http-framework.mjs')], {
    encoding: 'utf8',
  });
}

describe('check-http-framework build gate', () => {
  it('passes on the shipped scaffold', () => {
    const result = runCheck(scaffoldRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails when a legacy Fastify adapter is reintroduced', async () => {
    const workspace = await workspaceWith({
      'apps/api/src/server.ts': "import Fastify from 'fastify';\nexport default Fastify();\n",
    });
    const result = runCheck(workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/api/src/server.ts');
  });

  it('ignores installed and built directories', async () => {
    const workspace = await workspaceWith({
      'apps/api/node_modules/fastify/index.js': 'export {}\n',
      'apps/api/dist/server.js': 'const framework = "fastify";\n',
    });
    const result = runCheck(workspace);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
