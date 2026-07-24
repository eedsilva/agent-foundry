import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';
import { reserveEphemeralPort, waitForHttp } from './support.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const APP_SOURCE_DIR = resolve(REPO_ROOT, 'examples/issue-radar-app');
const STOP_TIMEOUT_MS = 60_000;

export interface IssueRadarFixture {
  appBaseUrl: string;
  dataDir: string;
  appDir: string;
  workdir: string;
  appProcess: ChildProcess;
}

export async function bootIssueRadarApp(projectId: string): Promise<IssueRadarFixture> {
  const [dataDir, appDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'agent-foundry-issue-radar-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-issue-radar-app-')),
  ]);

  // Anything assigned below is only known-created once its statement has run,
  // so on a mid-boot failure the catch block below can only clean up what
  // actually exists (mirroring teardownIssueRadarApp's own best-effort steps).
  let workdir: string | undefined;
  let appProcess: ChildProcess | undefined;

  try {
    // Copy the real example app (not its top-level node_modules/.next/supabase —
    // the Supabase environment is provisioned separately below, into workdir).
    // Only the *top-level* supabase/ dir (config + migrations) is excluded;
    // matching "supabase" as a path segment anywhere would also strip the
    // app's own lib/supabase/ Supabase client helpers.
    const topLevelExclusions = new Set(['node_modules', '.next', 'supabase']);
    await cp(APP_SOURCE_DIR, appDir, {
      recursive: true,
      filter: (source) => {
        const rel = relative(APP_SOURCE_DIR, source);
        if (rel === '') return true;
        return !topLevelExclusions.has(rel.split(sep)[0]);
      },
    });
    await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: appDir,
      timeout: 5 * 60_000,
    });

    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'real',
    });
    if (!runtime.generatedProjectRuntime) {
      throw new Error('Real-mode runtime did not wire a generatedProjectRuntime.');
    }
    await runtime.generatedProjectRuntime.initialize({ projectId });
    workdir = join(dataDir, 'projects', projectId, 'environment');

    // Apply the real Issue Radar migrations (read from the checked-in example,
    // not re-typed here) on top of the storage migration `initialize()`
    // already installed.
    const migrationsSourceDir = join(APP_SOURCE_DIR, 'supabase', 'migrations');
    const migrationsTargetDir = join(workdir, 'supabase', 'migrations');
    const issueRadarMigrations = (await readdir(migrationsSourceDir)).filter((name) =>
      name.endsWith('.sql'),
    );
    for (const name of issueRadarMigrations.sort()) {
      const targetPath = join(migrationsTargetDir, name);
      try {
        await readFile(targetPath);
        continue; // already installed by initialize() (the storage migration)
      } catch {
        // not present yet — copy and apply it
      }
      await cp(join(migrationsSourceDir, name), targetPath);
      await runtime.generatedProjectRuntime.migrate({
        projectId,
        migrationPath: `supabase/migrations/${name}`,
      });
    }

    const envPath = join(dataDir, 'projects', projectId, '.env');
    const secrets = parseDotEnv(await readFile(envPath, 'utf8'));
    const supabaseUrl = secrets.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = secrets.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      throw new Error('Supabase runtime did not produce app credentials.');
    }

    const port = await reserveEphemeralPort();
    const appBaseUrl = `http://127.0.0.1:${port}`;
    const appEnv = {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      APP_BASE_URL: appBaseUrl,
    };

    // Boot the app the same way its own Dockerfile does — a production build
    // run via the standalone server.js — rather than `next dev`. `next dev`'s
    // client bundle never completes hydration in this sandbox (its HMR
    // WebSocket upgrade never succeeds, and the dev client appears to gate
    // hydration on that handshake), which was verified by comparing React
    // fiber attachment on the DOM: none on `next dev`, present under
    // `next build` + standalone `server.js`. The production boot is also a
    // more faithful "golden journey" check, since it exercises the exact
    // artifact examples/issue-radar-app/Dockerfile ships.
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

    return { appBaseUrl, dataDir, appDir, workdir, appProcess };
  } catch (error) {
    appProcess?.kill();
    if (workdir) {
      try {
        await execFileAsync(
          'supabase',
          ['stop', '--workdir', workdir, '--no-backup', '--yes'],
          { timeout: STOP_TIMEOUT_MS },
        );
      } catch {
        // best-effort: temp dirs get removed below regardless
      }
    }
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(appDir, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

export async function teardownIssueRadarApp(fixture: IssueRadarFixture): Promise<void> {
  fixture.appProcess.kill();
  try {
    await execFileAsync(
      'supabase',
      ['stop', '--workdir', fixture.workdir, '--no-backup', '--yes'],
      { timeout: STOP_TIMEOUT_MS },
    );
  } catch {
    // best-effort: temp dirs get removed below regardless
  }
  await Promise.all([
    rm(fixture.dataDir, { recursive: true, force: true }),
    rm(fixture.appDir, { recursive: true, force: true }),
  ]);
}
