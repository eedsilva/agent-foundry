import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { parse as parseDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCAFFOLD_DIR = resolve(REPO_ROOT, 'harness/scaffolds/nextjs');
const PROJECT_ID = 'generated-app-auth-e2e';
const STOP_TIMEOUT_MS = 60_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;

async function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

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

    // Assembles a minimal, real Next.js app around the actual scaffold
    // files (copied, not reimplemented) so this test catches drift between
    // harness/scaffolds/nextjs and a runnable App Router project, instead
    // of exercising a second copy of the same UI code.
    await cp(SCAFFOLD_DIR, appDir, { recursive: true });
    await writeFile(
      join(appDir, 'package.json'),
      JSON.stringify({
        name: 'generated-app-auth-fixture',
        private: true,
        version: '0.0.0',
        dependencies: {
          next: '16.2.11',
          react: '19.1.1',
          'react-dom': '19.1.1',
          '@supabase/ssr': '^0.12.3',
          '@supabase/supabase-js': '^2.58.0',
        },
        devDependencies: {
          typescript: '^5',
          '@types/node': '^22',
          '@types/react': '^19',
        },
      }),
    );
    await writeFile(
      join(appDir, 'next.config.mjs'),
      "/** @type {import('next').NextConfig} */\nexport default {};\n",
    );
    await writeFile(
      join(appDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2017',
          lib: ['dom', 'dom.iterable', 'esnext'],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: 'preserve',
          incremental: true,
          paths: { '@/*': ['./*'] },
        },
        include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
        exclude: ['node_modules'],
      }),
    );
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
    await runtime.generatedProjectRuntime.initialize({ projectId: PROJECT_ID });
    workdir = join(dataDir, 'projects', PROJECT_ID, 'environment');

    // The real credential bridge (packages/platform/src/supabase-secrets.ts,
    // wired into SupabaseGeneratedProjectRuntime#initialize) already wrote
    // this file; read it the same way NodePreviewRunner's SecretStore does
    // in production instead of deriving credentials a second way.
    const envPath = join(dataDir, 'projects', PROJECT_ID, '.env');
    const secrets = parseDotEnv(await readFile(envPath, 'utf8'));
    const supabaseUrl = secrets.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      throw new Error('Supabase runtime did not produce app credentials.');
    }

    const port = await reserveEphemeralPort();
    appBaseUrl = `http://127.0.0.1:${port}`;
    appProcess = spawn('npx', ['next', 'dev', '-p', String(port)], {
      cwd: appDir,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      },
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
