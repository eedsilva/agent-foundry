import { spawn, spawnSync } from 'node:child_process';
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
const authServers: ReturnType<typeof spawn>[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  for (const child of authServers.splice(0)) child.kill();
});

type AuthResponse = { status: number; body: string };

// The seed check's own request answers immediately, so start does not touch
// the seeded-user's real password — it only asserts a GoTrue-shaped 200/4xx.
const SEEDED_AUTH_RESPONSE: AuthResponse = { status: 200, body: '{"access_token":"stub-token"}' };
const REJECTED_AUTH_RESPONSE: AuthResponse = {
  status: 400,
  body: '{"error":"invalid_grant","error_description":"Invalid login credentials"}',
};

// The seed-check stand-in for GoTrue has to live in its own OS process, not
// this test file's event loop: run() drives db.mjs with spawnSync, which
// blocks this process until the child exits, so an in-process listener could
// never get a turn to answer the child's request while that block is in
// effect. A bare `node -e` with no deps keeps this out of the scaffold script
// itself, which is what has to stay dependency-free.
const AUTH_SERVER_SCRIPT = `
const { createServer } = require('node:http');
const server = createServer((_req, res) => {
  res.writeHead(Number(process.env.AUTH_STATUS), { 'content-type': 'application/json' });
  res.end(process.env.AUTH_BODY);
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

async function startAuthServer(authResponse: AuthResponse) {
  const child = spawn(process.execPath, ['-e', AUTH_SERVER_SCRIPT], {
    env: { ...process.env, AUTH_STATUS: String(authResponse.status), AUTH_BODY: authResponse.body },
  });
  authServers.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      const value = Number(chunk.toString().trim());
      if (Number.isInteger(value)) resolve(value);
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`auth server exited early (code ${code})`)));
  });
  return { child, origin: `http://127.0.0.1:${port}` };
}

// `status` answers the way the CLI does, echoing back the port it was actually
// started on — which is what proves the allocated block reached it. `gen` ends
// its output with a blank line, exactly like the real `supabase gen types`.
// STUB_STATUS_FAIL_PORT makes `status` fail while db.mjs's recorded
// SUPABASE_DB_PORT is that one port, standing in for "this is not my stack" —
// it stops failing once the workspace reallocates off that port, just like
// the real CLI would succeed once this project's own stack is on new ports.
// API_URL is the test's own real `node:http` listener (STUB_AUTH_ORIGIN,
// always injected by run()) rather than a bare $SUPABASE_API_PORT URL, because
// db.mjs's seed check now makes a real request to whatever API_URL it is told.
const STUB_CLI = `#!/bin/sh
if [ "$1" = "status" ]; then
  if [ -n "$STUB_STATUS_FAIL_PORT" ] && [ "$SUPABASE_DB_PORT" = "$STUB_STATUS_FAIL_PORT" ]; then
    exit 1
  fi
  printf '{"API_URL":"%s","ANON_KEY":"anon-key","SERVICE_ROLE_KEY":"service-role-key"}' "$STUB_AUTH_ORIGIN"
fi
if [ "$1" = "gen" ]; then
  printf 'export type Database = Record<string, never>\\n\\n'
fi
exit 0
`;

/** A throwaway copy of the scaffold's scripts, with a stub CLI on PATH and a
 * real HTTP listener standing in for GoTrue's password-grant endpoint. Every
 * workspace gets one — db.mjs's seed check now runs on every `start`/`reset`
 * that reaches completion, so every case that completes one needs a live
 * listener behind it, not just the cases that are about the seed check. */
async function scaffoldWorkspace(initialAuthResponse: AuthResponse = SEEDED_AUTH_RESPONSE) {
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
  await mkdir(join(workspace, 'supabase'), { recursive: true });
  await cp(join(scaffoldRoot, 'supabase/seed.sql'), join(workspace, 'supabase/seed.sql'));

  let auth = await startAuthServer(initialAuthResponse);

  return {
    workspace,
    get authOrigin() {
      return auth.origin;
    },
    /** Replaces the auth stand-in with one answering differently, so a test
     * can prove a later command (`reset`) re-runs the seed check rather than
     * trusting the first pass. */
    async setAuthResponse(next: AuthResponse) {
      auth.child.kill();
      auth = await startAuthServer(next);
    },
    run(command: string[], extraEnv: Record<string, string> = {}) {
      return spawnSync(process.execPath, [join(workspace, 'scripts/db.mjs'), ...command], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          STUB_AUTH_ORIGIN: auth.origin,
          ...extraEnv,
        },
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

  it('writes the credentials the started stack reports', async () => {
    const project = await startProject();

    expect(project.values.NEXT_PUBLIC_SUPABASE_URL).toBe(project.authOrigin);
    expect(project.values.NEXT_PUBLIC_SUPABASE_ANON_KEY).toBe('anon-key');
    expect(project.values.SUPABASE_SERVICE_ROLE_KEY).toBe('service-role-key');
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

  // Issue #560: the stack came up healthy but supabase/seed.sql never
  // applied, so the browser hit "Invalid login credentials" long after
  // db:start had already reported success. start now proves the seed landed
  // the same way the browser and scripts/smoke.mjs do: a real password grant.
  it('logs the verified seed user when the seed check succeeds', async () => {
    const project = await scaffoldWorkspace(SEEDED_AUTH_RESPONSE);

    const result = project.run(['start']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('owner@example.com');
  });

  it('refuses to report success when the seed user cannot sign in', async () => {
    const project = await scaffoldWorkspace(REJECTED_AUTH_RESPONSE);

    // Short-circuits the real tens-of-seconds deadline: GoTrue answers
    // immediately here, so the check never retries, but this keeps the test
    // fast even if that stops being true.
    const result = project.run(['start'], { DB_SEED_CHECK_DEADLINE_MS: '1000' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('seed.sql');
    expect(result.stderr).toContain('pnpm db:reset');
  });

  it('runs the same seed verification on reset', async () => {
    const project = await startProject();
    await project.setAuthResponse(REJECTED_AUTH_RESPONSE);

    const result = project.run(['reset'], { DB_SEED_CHECK_DEADLINE_MS: '1000' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('seed.sql');
    expect(result.stderr).toContain('pnpm db:reset');
  });

  // Without this guard, an app that legitimately rewrote its seed would fail
  // db:start forever — worse than the bug being fixed.
  it('skips the seed check when seed.sql no longer declares the documented user', async () => {
    const project = await scaffoldWorkspace(REJECTED_AUTH_RESPONSE);
    await writeFile(join(project.workspace, 'supabase/seed.sql'), '-- no seeded users here\n');

    const result = project.run(['start']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seed check skipped');
    expect(result.stdout).toContain('seed.sql');
  });

  // Deleting seed.sql (with `[db.seed]` disabled) is the most literal form of
  // "customised its seed" — it must skip like the content-mismatch case, not
  // crash with a raw ENOENT stack trace.
  it('skips the seed check when seed.sql does not exist', async () => {
    const project = await scaffoldWorkspace(REJECTED_AUTH_RESPONSE);
    await rm(join(project.workspace, 'supabase/seed.sql'));

    const result = project.run(['start']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('seed check skipped');
    expect(result.stdout).toContain('seed.sql');
  });
});
