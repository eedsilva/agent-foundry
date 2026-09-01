import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { parse as parseDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';
import { reserveEphemeralPort, waitForHttp } from './support.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCAFFOLD_DIR = resolve(REPO_ROOT, 'harness/scaffolds/nextjs/apps/web');
const PROJECT_ID = 'generated-app-auth-e2e';
const STOP_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;

test.describe('generated app auth', () => {
  test.describe.configure({ timeout: SETUP_TIMEOUT_MS });

  let appProcess: ChildProcess;
  let appBaseUrl: string;
  let dataDir: string;
  let appDir: string;
  let workdir: string;

  test.beforeAll(async () => {
    [dataDir, appDir] = await Promise.all([
      mkdtemp(join(tmpdir(), 'agent-foundry-auth-e2e-data-')),
      mkdtemp(join(tmpdir(), 'agent-foundry-auth-e2e-app-')),
    ]);

    // Runs the scaffold's own web tier verbatim — its package.json, tsconfig
    // and next.config come from the scaffold now (#315), so this catches drift
    // between harness/scaffolds/nextjs and a runnable App Router project
    // instead of exercising a second, hand-written copy of that config.
    // The filter matters when the scaffold has been installed and run in
    // place: its node_modules symlinks into a pnpm store this copy does not
    // carry, and its .next was built at a different absolute path.
    const localOnly = new Set(['node_modules', '.next', 'dist']);
    await cp(SCAFFOLD_DIR, appDir, {
      recursive: true,
      filter: (source) => !source.split(sep).some((segment) => localOnly.has(segment)),
    });
    await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      timeout: 5 * 60_000,
    });

    // Real-mode createRuntime wires the same SupabaseGeneratedProjectRuntime
    // production uses (packages/composition/src/runtime.ts) instead of
    // constructing @agent-foundry/platform directly, which apps/api's
    // architecture rules (scripts/lib/architecture.mjs) forbid.
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'real',
    });
    if (!runtime.generatedProjectRuntime) {
      throw new Error('Real-mode runtime did not wire a generatedProjectRuntime.');
    }
    // Provisioned by hand, outside any Run Candidate, so `manual-preview` is
    // the only class that describes it. #618 removed the project-wide address
    // this used to rely on: the environment has to be named to be reachable.
    const environment = await runtime.generatedProjectRuntime.initialize({
      projectId: PROJECT_ID,
      identity: {
        class: 'manual-preview',
        projectId: PROJECT_ID,
        environmentId: 'e2e',
        migrationDigest: createHash('sha256').update(PROJECT_ID).digest('hex'),
      },
    });
    workdir = environment.workdir;

    // The real credential bridge (packages/platform/src/supabase-secrets.ts,
    // wired into SupabaseGeneratedProjectRuntime#initialize) already wrote
    // this file; read it the same way NodePreviewRunner's SecretStore does
    // in production instead of deriving credentials a second way.
    // Sibling of the environment's workdir, per environment since #618.
    const envPath = join(dirname(workdir), '.env');
    const secrets = parseDotEnv(await readFile(envPath, 'utf8'));
    const supabaseUrl = secrets.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new Error('Supabase runtime did not produce app credentials.');
    }

    const port = await reserveEphemeralPort();
    appBaseUrl = `http://127.0.0.1:${port}`;
    const appEnv = {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
    };

    // Boot a production build via the standalone server, not `next dev` —
    // same reason issue-radar-fixture.ts does: `next dev`'s client bundle
    // never completes hydration here (its HMR WebSocket upgrade never
    // succeeds), so the scaffold's 'use client' sign-up form never attaches
    // its onSubmit handler and the click falls through to a native GET
    // submit, landing on /sign-up? instead of /.
    await execFileAsync('npm', ['run', 'build'], {
      cwd: appDir,
      env: appEnv,
      timeout: 5 * 60_000,
    });
    const standaloneDir = join(appDir, '.next', 'standalone');
    await cp(join(appDir, '.next', 'static'), join(standaloneDir, '.next', 'static'), {
      recursive: true,
    });
    appProcess = spawn('node', ['server.js'], {
      cwd: standaloneDir,
      env: { ...appEnv, PORT: String(port), HOSTNAME: '127.0.0.1' },
      stdio: 'pipe',
    });
    await waitForHttp(`${appBaseUrl}/sign-up`, 60_000);
  });

  test.afterAll(async () => {
    appProcess?.kill();
    try {
      await execFileAsync('supabase', ['stop', '--workdir', workdir, '--no-backup', '--yes'], {
        timeout: STOP_TIMEOUT_MS,
      });
    } catch {
      // best-effort: temp dirs get removed below regardless
    }
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(appDir, { recursive: true, force: true }),
    ]);
  });

  test('redirects an unauthenticated visitor away from the protected page', async ({ page }) => {
    await page.goto(`${appBaseUrl}/`);
    await expect(page).toHaveURL(`${appBaseUrl}/sign-in`);
  });

  test('signs up, lands on the protected page, signs out, and logs back in', async ({ page }) => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;

    await page.goto(`${appBaseUrl}/sign-up`);
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(`${appBaseUrl}/`);
    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(`${appBaseUrl}/sign-in`);

    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(`${appBaseUrl}/`);
    await expect(page.getByText(email)).toBeVisible();
  });
});
