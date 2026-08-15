// Runs this project's own Supabase stack (ADR 0007) — the Docker Compose
// project the Supabase CLI manages from supabase/config.toml.
//
// Everything that has to be unique per project lives in .env: the Compose
// project name and one block of host ports. They are allocated on the first
// `db:start`, and re-probed on every later `start` in case a sibling project
// claimed one of the ports while this stack was stopped, so two generated
// projects running at the same time do not fight over 54321. The block is
// picked from a hash of this workspace's path and then probed, the same shape
// as the platform's allocator in packages/platform/src/supabase-runtime.ts.
//
// Dependency-free on purpose: this runs before `pnpm install` has to have
// worked, and in CI, from a directory copied out of the repo.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
const TYPES_PATH = join(root, 'apps', 'api', 'src', 'database.types.ts');
const SEED_SQL_PATH = join(root, 'supabase', 'seed.sql');

// api, db, shadow db, studio — the four host ports supabase/config.toml binds.
const PORT_VARS = [
  'SUPABASE_API_PORT',
  'SUPABASE_DB_PORT',
  'SUPABASE_DB_SHADOW_PORT',
  'SUPABASE_STUDIO_PORT',
];
const PORT_BASE = 54_320;
const SLOT_COUNT = 200;

/** Rewrites KEY=value lines in .env, appending the ones that aren't there yet. */
function setEnv(updates) {
  let text = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const existing = new RegExp(`^${key}=.*$`, 'm');
    text = existing.test(text)
      ? text.replace(existing, line)
      : `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
    process.env[key] = value;
  }
  writeFileSync(envPath, text);
}

function isFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

// ponytail: a block is taken if something is listening on it right now, which
// is all a workspace can see on its own — two stopped projects that hash to the
// same slot would both claim it, and the second one to start fails loudly on a
// bound port. The platform's allocator reads every sibling project's config
// instead; a workspace has no sibling to read.
async function allocate() {
  const digest = createHash('sha256').update(root).digest();
  const preferred = digest.readUInt32BE(0) % SLOT_COUNT;
  for (let attempt = 0; attempt < SLOT_COUNT; attempt += 1) {
    const base = PORT_BASE + ((preferred + attempt) % SLOT_COUNT) * PORT_VARS.length;
    const ports = PORT_VARS.map((_, offset) => base + offset);
    const free = await Promise.all(ports.map(isFree));
    if (!free.every(Boolean)) continue;
    const projectId = `app_${digest.toString('hex').slice(0, 8)}`;
    setEnv({
      // Becomes the Compose project name, so it has to be unique too — and a
      // valid identifier: leading digits and dashes are not.
      SUPABASE_PROJECT_ID: projectId,
      ...Object.fromEntries(PORT_VARS.map((name, index) => [name, ports[index]])),
    });
    console.log(`db: allocated ${projectId} on ports ${ports.join(', ')}`);
    return;
  }
  throw new Error(
    `No free Supabase port block between ${PORT_BASE} and ${PORT_BASE + SLOT_COUNT * PORT_VARS.length - 1}.`,
  );
}

function runSupabase(args, stdio) {
  const result = spawnSync('supabase', args, { cwd: root, stdio, encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    throw new Error('The Supabase CLI is not installed: https://supabase.com/docs/guides/cli');
  }
  if (result.error) throw result.error;
  return result;
}

function supabase(args, { capture = false } = {}) {
  const result = runSupabase(args, capture ? ['inherit', 'pipe', 'inherit'] : 'inherit');
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout ?? '';
}

// Non-fatal, unlike supabase(): a failure here means a recorded block is
// bound by a sibling project, not that db:start itself failed, so it must
// return rather than exit — and stay silent, since that is an expected
// outcome, not an error to surface on the terminal.
function supabaseStatusOk() {
  return runSupabase(['status', '--output', 'json'], 'ignore').status === 0;
}

const SEED_USER = { email: 'owner@example.com', password: 'password123' };
// A few tens of seconds, one attempt per second: long enough for GoTrue to
// finish warming up after the containers report healthy. Overridable so a
// test whose listener is already up does not have to wait out the real bound
// to see a failure.
const SEED_CHECK_DEADLINE_MS = Number(process.env.DB_SEED_CHECK_DEADLINE_MS ?? 30_000);

// Issue #560: a stack can come up with every container healthy and still have
// nothing behind the login form, because supabase/seed.sql never applied —
// and db:start had already reported success. Verified the same way the
// browser and scripts/smoke.mjs do: a real password grant against GoTrue.
//
// ponytail: this reduces "the seed applied" to "the documented seed user can
// sign in" — a workspace has no dependency-free way to query auth.users
// directly, so a successful password grant is the closest proof available.
function fail(reason) {
  console.error(`db: ${reason}`);
  console.error('db: supabase/seed.sql may not have applied. Run `pnpm db:reset`.');
  process.exit(1);
}

async function verifySeed(status) {
  // Missing or unreadable is not evidence of an unseeded stack either — an
  // app that opts out of seeding (no [db.seed], seed.sql deleted) is the most
  // literal form of "customised its seed", and must skip like any other.
  let seedSql;
  try {
    seedSql = readFileSync(SEED_SQL_PATH, 'utf8');
  } catch {
    seedSql = '';
  }
  if (!seedSql.includes(SEED_USER.email)) {
    console.log(
      `db: seed check skipped — supabase/seed.sql no longer declares ${SEED_USER.email}.`,
    );
    return;
  }

  const url = `${status.API_URL}/auth/v1/token?grant_type=password`;
  const deadline = Date.now() + SEED_CHECK_DEADLINE_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { apikey: status.ANON_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(SEED_USER),
      });
      if (response.ok) {
        console.log(`db: seed ok — ${SEED_USER.email} can sign in.`);
        return;
      }
      // GoTrue answered, so it is up — a wrong password will not fix itself
      // by retrying, so this is the final word, not a warm-up hiccup.
      const body = await response.text();
      fail(`${SEED_USER.email} could not sign in — HTTP ${response.status}: ${body}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(1000);
    }
  }
  fail(`${SEED_USER.email} never reached GoTrue — ${lastError}.`);
}

// The CLI reads .env itself when it resolves the env(...) references in
// config.toml; this process reads it too so allocation can tell whether the
// block already exists.
if (!existsSync(envPath)) copyFileSync(join(root, '.env.example'), envPath);
process.loadEnvFile(envPath);

const args = process.argv.slice(2);

// Only `start` may claim a block. Every other command talks to a stack that is
// supposed to exist already, and allocating one for `stop` would write port
// state for a stack nobody started.
if (!process.env.SUPABASE_PROJECT_ID) {
  if (args[0] !== 'start') {
    console.error('db: this workspace has no Supabase stack yet — run `pnpm db:start` first.');
    process.exit(1);
  }
  await allocate();
} else if (args[0] === 'start') {
  // A recorded block can go stale while this stack is stopped: a sibling
  // project can claim one of its ports, and there is then no way out but a
  // fresh allocation. Only ask the CLI when a port is actually bound — a free
  // block is proof enough that nothing has moved in under it, and `supabase
  // status` costs a CLI round trip other `start`s don't need to pay.
  const recordedPorts = PORT_VARS.map((name) => Number(process.env[name]));
  const free = await Promise.all(recordedPorts.map(isFree));
  if (!free.every(Boolean) && !supabaseStatusOk()) await allocate();
}

// `gen types` is captured rather than redirected by the npm script because its
// output ends in a blank line, and `git diff --check` — one of the checks every
// task has to pass — rejects a blank line at end of file.
if (args[0] === 'gen') {
  writeFileSync(TYPES_PATH, `${supabase(args, { capture: true }).trimEnd()}\n`);
  console.log(`db: types written to ${relative(root, TYPES_PATH)}`);
  process.exit(0);
}

supabase(args);

// The keys are generated by the stack, so .env can only be completed once it
// is up. This is the local-development stand-in for the platform's credential
// bridge (ADR 0034), which writes the same three values for a real project.
if (args[0] === 'start') {
  const status = JSON.parse(supabase(['status', '--output', 'json'], { capture: true }));
  setEnv({
    NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  });
  console.log(`db: ${status.API_URL} — credentials written to .env`);
  await verifySeed(status);
}

// The real npm script forwards `db reset` verbatim to the Supabase CLI
// (`supabase db reset`), so args is ['db', 'reset'], never ['reset'] — hence
// `includes`, not `args[0] ===`. `reset` reapplies migrations and seed.sql
// but writes no new credentials — the stack's URL and keys do not change —
// so this only re-runs the seed check; `pnpm db:types` stays the explicit
// step for regenerating types.
if (args.includes('reset')) {
  const status = JSON.parse(supabase(['status', '--output', 'json'], { capture: true }));
  await verifySeed(status);
}

// Fires for every command that reaches here (start, reset, stop — not just
// the ones with a seed check): supabase(args) above already asserted a zero
// exit, but fetch()'s keep-alive socket would otherwise hold the process
// open until it idles out, so every command would linger, not just the ones
// that call verifySeed.
process.exit(0);
