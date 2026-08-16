// Issue #560 (R3): `pnpm dev` runs `pnpm --recursive --parallel dev`, which
// starts `next dev` with cwd apps/web. @next/env's loadEnvConfig(dir) reads
// .env* from that directory, not the workspace root, so the web tier never
// sees the .env `pnpm db:start` writes at the root — verified against the
// installed @next/env. The fix can't live in apps/web/next.config.ts either:
// @next/env snapshots process.env on first load and replaces it wholesale on
// every reload, so anything injected there is outside that snapshot and gets
// dropped. Loading .env here, before spawning both tiers, is the same
// load-then-spawn sequence scripts/smoke.mjs already uses.
//
// A value already in the environment has to win, because the platform's
// credential bridge (ADR 0034) injects the real Supabase credentials into
// this process's env before `pnpm dev` runs and a stale .env must not
// clobber them. process.loadEnvFile gives that for free — it skips any key
// already set, the same default dotenv has — which is why apps/api/src/env.ts
// loads the same file with no guard. scaffold-env.test.ts pins the behaviour
// rather than trusting the comment. Dependency-free on purpose: this has to
// run before `pnpm install` in a directory copied out of the repo.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const envPath = join(root, '.env');

if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
  console.log(`dev: loaded ${envPath}`);
} else {
  console.log('dev: no .env — run `pnpm db:start` first for the Supabase URL and keys.');
}

const child = spawn('pnpm', ['--recursive', '--parallel', 'dev'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
