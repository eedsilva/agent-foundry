import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
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
// STUB_STATUS_FAIL_PORT makes `status` fail while db.mjs's recorded
// SUPABASE_DB_PORT is that one port, standing in for "this is not my stack" —
// it stops failing once the workspace reallocates off that port, just like
// the real CLI would succeed once this project's own stack is on new ports.
const STUB_CLI = `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ -n "$STUB_STATUS_FAIL_PORT" ] && [ "$SUPABASE_DB_PORT" = "$STUB_STATUS_FAIL_PORT" ]; then
    exit 1
  fi
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
    run(command: string[], extraEnv: Record<string, string> = {}) {
      return spawnSync(process.execPath, [join(workspace, 'scripts/db.mjs'), ...command], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ...extraEnv },
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

/** Binds `port` for the duration of `fn`, standing in for a sibling project
 * (or this project's own running stack) already holding it. */
async function withBoundPort<T>(port: number, fn: () => Promise<T>): Promise<T> {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  try {
    return await fn();
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
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

  // A stopped stack's ports are fair game for a sibling project. If one of
  // them is bound and `supabase status` fails, that block is not this
  // project's own stack — it belongs to someone else, and start must move on
  // to a fresh one rather than fight for the old ports.
  it('re-allocates when the recorded block is bound and it is not this stack', async () => {
    const project = await startProject();
    const takenPort = Number(project.values.SUPABASE_DB_PORT);

    const result = await withBoundPort(takenPort, async () =>
      project.run(['start'], { STUB_STATUS_FAIL_PORT: String(takenPort) }),
    );

    expect(result.status).toBe(0);
    const values = await project.env();
    expect(ports(values)).not.toEqual(ports(project.values));
    expect(ports(values)).not.toContain(takenPort);
  });

  // A bound port whose `supabase status` succeeds is this project's own
  // stack, already running — reusing the block is correct, not a bug.
  it('keeps the block when a bound port is this own project already running', async () => {
    const project = await startProject();
    const boundPort = Number(project.values.SUPABASE_DB_PORT);

    const result = await withBoundPort(boundPort, async () => project.run(['start']));

    expect(result.status).toBe(0);
    expect(await project.env()).toEqual(project.values);
  });

  it('logs the allocated project id and ports on start', async () => {
    const project = await scaffoldWorkspace();

    const result = project.run(['start']);
    expect(result.status).toBe(0);
    const values = await project.env();

    expect(result.stdout).toContain(`db: allocated ${values.SUPABASE_PROJECT_ID}`);
    for (const port of ports(values)) {
      expect(result.stdout).toContain(String(port));
    }
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
