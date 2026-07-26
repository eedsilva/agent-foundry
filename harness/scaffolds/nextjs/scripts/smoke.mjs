// Boots the workspace the way a developer does (`pnpm dev`) and asserts both
// tiers answer. Dependency-free on purpose: it has to run immediately after a
// frozen-lockfile install, in CI, in a directory copied out of the repo.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const API_URL = 'http://127.0.0.1:3001/health';
const WEB_URL = 'http://127.0.0.1:3000/sign-in';
const TIMEOUT_MS = 180_000;

const dev = spawn('pnpm', ['dev'], {
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    // ponytail: placeholders so this runs before a project has a local
    // Supabase stack. Real values reach the dev server through the credential
    // bridge (ADR 0034). Drop these once #316 boots Supabase alongside the
    // tiers — until then a fake key would let a bridge failure smoke green.
    // `||`, not `??`: an exported-but-empty variable is as unusable as none.
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || 'http://127.0.0.1:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'smoke-placeholder-anon-key',
  },
});

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
  // waiting for the API before starting it would serialise two independent boots.
  await Promise.all([
    waitFor('api', API_URL, (body) => JSON.parse(body).status === 'ok'),
    waitFor('web', WEB_URL, (body) => body.includes('Sign in')),
  ]);
  console.log('smoke: both tiers booted');
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
