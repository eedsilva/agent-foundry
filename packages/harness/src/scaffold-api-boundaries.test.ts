import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const scaffoldRoot = resolve(import.meta.dirname, '../../../harness/scaffolds/nextjs');
const checkScript = join(scaffoldRoot, 'scripts/check-api-boundaries.mjs');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function workspaceWith(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scaffold-api-boundaries-'));
  temporaryDirectories.push(dir);
  await mkdir(join(dir, 'scripts'), { recursive: true });
  await mkdir(join(dir, 'apps/api/src'), { recursive: true });
  await cp(checkScript, join(dir, 'scripts/check-api-boundaries.mjs'));
  await writeFile(join(dir, 'apps/api/src/app.ts'), source);
  return dir;
}

function runCheck(workspace: string) {
  return spawnSync(process.execPath, [join(workspace, 'scripts/check-api-boundaries.mjs')], {
    encoding: 'utf8',
  });
}

describe('generated API boundary build gate', () => {
  it('passes on the shipped scaffold', () => {
    const result = runCheck(scaffoldRoot);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it.each([
    "response.headers.set('Access-Control-Allow-Origin', '*');\n",
    "import { cors } from 'hono/cors';\napp.use(cors());\n",
  ])('fails when an API handler configures CORS: %s', async (source) => {
    const result = runCheck(await workspaceWith(source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CORS configuration');
  });

  it.each([
    "const token = request.headers.get('cookie');\n",
    "const token = getCookie(c, 'token');\n",
  ])('fails when an API handler authenticates from a cookie: %s', async (source) => {
    const result = runCheck(await workspaceWith(source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cookie-auth reference');
  });

  it.each([
    "console.log('request', accessToken);\n",
    'console.error(error);\n',
    'console.log(apiKey);\n',
    'console.error(caughtError);\n',
    'console.log(getSecret());\n',
    'console.log(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);\n',
    'console.log(\n  error,\n);\n',
    'const leak = error;\nconsole.error(leak);\n',
    'logger.error(error);\n',
    "console['error'](error);\n",
    'console.error?.(error);\n',
    'const { error: emit } = console; emit(error);\n',
    'const emit = console.error;\nemit(error);\n',
  ])('fails when an API handler logs without redaction: %s', async (source) => {
    const result = runCheck(await workspaceWith(source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('API logging is not permitted');
  });

  it.each(["console.info('API started');\n", "logger.debug('API started');\n"])(
    'fails when an API handler logs a non-sensitive message: %s',
    async (source) => {
      const result = runCheck(await workspaceWith(source));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('API logging is not permitted');
    },
  );
});
