import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseDotEnv } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

// The scaffold's scripts/db.mjs allocates the Compose project name and the host
// port block a generated project's Supabase stack runs on. Two projects running
// at once must not land on the same ones, and nothing below the script itself
// can assert that — so this drives the real file with a stub CLI on PATH, no
// Docker involved.
const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// `status` answers the way the CLI does, echoing back the port it was actually
// started on — which is what proves the allocated block reached it. `gen` ends
// its output with a blank line, exactly like the real `supabase gen types`.
const STUB_CLI = `#!/bin/sh
if [ "$1" = "status" ]; then
  printf '{"API_URL":"http://127.0.0.1:%s","ANON_KEY":"anon-key","SERVICE_ROLE_KEY":"service-role-key"}' "$SUPABASE_API_PORT"
fi
if [ "$1" = "gen" ]; then
  printf 'export type Database = Record<string, never>\\n\\n'
fi
exit 0
`;

/** A throwaway copy of the scaffold's scripts, with a stub CLI on PATH. */
async function scaffoldWorkspace() {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-db-'));
  temporaryDirectories.push(dir);
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'supabase'), STUB_CLI);
  await chmod(join(bin, 'supabase'), 0o755);
  const workspace = join(dir, 'workspace');
  await cp(join(scaffoldRoot, 'scripts'), join(workspace, 'scripts'), { recursive: true });
  await cp(join(scaffoldRoot, '.env.example'), join(workspace, '.env.example'));
  await mkdir(join(workspace, 'apps/api/src'), { recursive: true });

  return {
    run(command: string[]) {
      return spawnSync(process.execPath, [join(workspace, 'scripts/db.mjs'), ...command], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });
    },
    async env(): Promise<Record<string, string>> {
      return parseDotEnv(await readFile(join(workspace, '.env'), 'utf8'));
    },
    types(): Promise<string> {
      return readFile(join(workspace, 'apps/api/src/database.types.ts'), 'utf8');
    },
  };
}

async function startProject() {
  const project = await scaffoldWorkspace();
  const result = project.run(['start']);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return { ...project, values: await project.env() };
}

function ports(env: Record<string, string>): number[] {
  return ['API', 'DB', 'DB_SHADOW', 'STUDIO'].map((name) => Number(env[`SUPABASE_${name}_PORT`]));
}

describe('the scaffold db script', () => {
  it('gives two projects their own Compose project and port block', async () => {
    const [first, second] = await Promise.all([startProject(), startProject()]);

    expect(first!.values.SUPABASE_PROJECT_ID).toMatch(/^app_[0-9a-f]{8}$/);
    expect(second!.values.SUPABASE_PROJECT_ID).not.toBe(first!.values.SUPABASE_PROJECT_ID);
    expect(ports(first!.values).every(Number.isInteger)).toBe(true);
    expect(ports(first!.values).filter((port) => ports(second!.values).includes(port))).toEqual([]);
  });

  it('writes the credentials the started stack reports, on its allocated port', async () => {
    const { values } = await startProject();

    expect(values.NEXT_PUBLIC_SUPABASE_URL).toBe(`http://127.0.0.1:${values.SUPABASE_API_PORT}`);
    expect(values.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe('anon-key');
    expect(values.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
  });

  // Reallocating on the second start would move the stack's ports out from
  // under the containers already bound to them.
  it('keeps the block it already allocated when the stack is started again', async () => {
    const project = await startProject();

    expect(project.run(['start']).status).toBe(0);

    expect(await project.env()).toEqual(project.values);
  });

  // `supabase gen types` ends its output with a blank line, and `git diff
  // --check` — one of the deterministic checks every task has to pass — rejects
  // a blank line at end of file.
  it('writes generated types with no trailing blank line', async () => {
    const project = await startProject();

    expect(project.run(['gen', 'types', 'typescript', '--local']).status).toBe(0);

    expect(await project.types()).toBe('export type Database = Record<string, never>\n');
  });

  // Only `start` may claim a block: allocating one for a command that talks to
  // an existing stack would record ports for a stack nobody started.
  it('refuses a command other than start before a stack exists', async () => {
    const project = await scaffoldWorkspace();

    const result = project.run(['stop']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run `pnpm db:start` first');
    expect((await project.env()).SUPABASE_PROJECT_ID).toBeUndefined();
  });
});
