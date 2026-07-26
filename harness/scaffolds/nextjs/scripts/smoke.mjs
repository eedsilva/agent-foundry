// Asserts turn zero works: the data plane holds the baseline schema and its
// seed rows, and both tiers boot the way a developer boots them (`pnpm dev`).
// Run it after `pnpm db:start`. Dependency-free on purpose: it has to run
// immediately after a frozen-lockfile install, in CI, in a directory copied
// out of the repo.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');
if (!existsSync(envPath)) {
  console.error('smoke: no .env — run `pnpm db:start` first.');
  process.exit(1);
}
process.loadEnvFile(envPath);

// `||`, not `??`: an exported-but-empty variable is as unusable as none, and
// the API tier falls back to the same port for the same reason.
const API_URL = `http://127.0.0.1:${process.env.API_PORT || 3001}/health`;
const WEB_URL = 'http://127.0.0.1:3000/sign-in';
const TIMEOUT_MS = 180_000;

// Reading `items` twice is what proves all three at once: the migration
// applied (the table is there), the seed ran (service-role sees rows), and row
// level security is on (anon, having no policy, sees none of them).
async function checkDatabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error('smoke: .env is missing the Supabase URL or keys — run `pnpm db:start`.');
  }

  async function items(label, key) {
    const response = await fetch(`${url}/rest/v1/items?select=id`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`smoke: reading items as ${label} failed — HTTP ${response.status}: ${body}`);
    }
    return JSON.parse(body);
  }

  const seeded = await items('service role', serviceRoleKey);
  if (seeded.length === 0) {
    throw new Error('smoke: the items table is empty — did supabase/seed.sql run?');
  }
  const visibleToAnon = await items('anon', anonKey);
  if (visibleToAnon.length > 0) {
    throw new Error(
      `smoke: anon can read ${visibleToAnon.length} item(s) — row level security is not enforcing.`,
    );
  }
  console.log(`smoke: database ok — ${seeded.length} seeded item(s), none readable by anon`);
}

const dev = spawn('pnpm', ['dev'], { stdio: 'inherit', detached: true });

let devExit = null;
dev.on('exit', (code, signal) => {
  devExit = `pnpm dev exited (code ${code}, signal ${signal})`;
});

async function waitFor(label, url, accepts) {
  const deadline = Date.now() + TIMEOUT_MS;
  let last = 'no response yet';
  while (Date.now() < deadline) {
    // ponytail: only catches a dev server that exits. A watch-mode crash keeps
    // the process alive and still burns the full timeout.
    if (devExit) throw new Error(`smoke: ${label} unreachable — ${devExit}`);
    try {
      const response = await fetch(url);
      const body = await response.text();
      if (response.ok && accepts(body)) {
        console.log(`smoke: ${label} ok — ${url}`);
        return;
      }
      last = `HTTP ${response.status} — ${body.slice(0, 300)}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(1000);
  }
  throw new Error(`smoke: ${label} never answered at ${url}. Last attempt: ${last}`);
}

try {
  // Probed together: the web request is what triggers Next's first compile, so
  // waiting for the API before starting it would serialise two independent
  // boots, and the database check needs neither tier to be up.
  await Promise.all([
    checkDatabase(),
    waitFor('api', API_URL, (body) => JSON.parse(body).status === 'ok'),
    waitFor('web', WEB_URL, (body) => body.includes('Sign in')),
  ]);
  console.log('smoke: database and both tiers ok');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // Negative pid kills the whole process group: `pnpm dev` spawns the two dev
  // servers as children, and killing only the parent leaves them holding the
  // ports and this process alive.
  try {
    process.kill(-dev.pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

process.exit();
