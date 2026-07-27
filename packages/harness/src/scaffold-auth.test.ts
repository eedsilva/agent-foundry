import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// The scaffold's build-failing check keeps the service-role key off the
// request path (#317, ADR 0038). This drives the real script; the shipped
// cross-tenant browser plan is validated against its schema in
// packages/contracts/src/scaffold-browser-plan.test.ts, which owns that
// schema (harness may not depend on contracts).
const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-service-role.mjs');

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

/** A minimal workspace with the real check script and the given source files. */
async function workspaceWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-auth-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-service-role.mjs'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-service-role.mjs')], {
    encoding: 'utf8',
  });
}

describe('check-service-role build gate', () => {
  it('passes on the shipped scaffold', () => {
    const result = runCheck(scaffoldRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails the build when a request-path handler reads the service-role key', async () => {
    const workspace = await workspaceWith({
      'apps/api/src/items.ts': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    });
    const result = runCheck(workspace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/api/src/items.ts');
  });

  it('fails the build when the web tier reads the service-role key', async () => {
    const workspace = await workspaceWith({
      'apps/web/lib/db.ts': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    });
    const result = runCheck(workspace);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('apps/web/lib/db.ts');
  });

  it('ignores installed and built directories', async () => {
    // Load-bearing in CI: the scaffold is checked after `pnpm install` and
    // `pnpm build`, so dependency and build output must never count as a
    // request-path reference.
    const workspace = await workspaceWith({
      'apps/api/node_modules/@supabase/supabase-js/index.js':
        'const key = "SUPABASE_SERVICE_ROLE_KEY";',
      'apps/api/dist/server.js': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'apps/web/.next/server/page.js': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    });
    const result = runCheck(workspace);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('allows admin, cron and webhook paths, which have no caller to forward', async () => {
    const workspace = await workspaceWith({
      'apps/api/src/admin/rotate-keys.ts': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'apps/api/src/jobs/nightly.ts': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      'apps/api/src/webhooks/stripe.ts': 'const key = process.env.SUPABASE_SERVICE_ROLE_KEY;',
    });
    const result = runCheck(workspace);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
