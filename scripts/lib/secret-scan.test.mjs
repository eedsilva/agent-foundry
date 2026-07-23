import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  scanTrackedFiles,
  scanDirectoryFiles,
  assertNoRealEnvFilesTracked,
} from './secret-scan.mjs';

const run = promisify(execFile);

async function initGitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'af-secret-scan-'));
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await run('git', ['config', 'user.name', 'Test'], { cwd: root });
  return root;
}

test('scanTrackedFiles flags a pattern-shaped secret in a git-tracked file', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, 'config.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwx";');
  await run('git', ['add', '-A'], { cwd: root });

  const findings = await scanTrackedFiles(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'config.ts');
});

test('scanTrackedFiles ignores untracked files', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, 'config.ts'), 'const key = "sk-abcdefghijklmnopqrstuvwx";');
  // not git add'ed

  const findings = await scanTrackedFiles(root);
  assert.deepEqual(findings, []);
});

test('assertNoRealEnvFilesTracked throws when a real .env is git-tracked', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, '.env'), 'SECRET=leak');
  await run('git', ['add', '-A'], { cwd: root });

  await assert.rejects(() => assertNoRealEnvFilesTracked(root), /\.env is tracked by Git/);
});

test('assertNoRealEnvFilesTracked allows .env.example', async () => {
  const root = await initGitRepo();
  await writeFile(join(root, '.env.example'), 'SECRET=');
  await run('git', ['add', '-A'], { cwd: root });

  await assert.doesNotReject(() => assertNoRealEnvFilesTracked(root));
});

test('scanDirectoryFiles flags a secret in a built (untracked) client bundle chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-secret-scan-'));
  const bundleDir = join(root, 'apps/web/.next');
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, 'chunk.js'), 'var k="sk-abcdefghijklmnopqrstuvwx"');
  // Deliberately not git-tracked — .next is gitignored; the scan must still
  // catch a secret baked into build output that Git would never see.

  const findings = await scanDirectoryFiles(bundleDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, join(bundleDir, 'chunk.js'));
});

test('scanDirectoryFiles is a no-op when the directory does not exist (build not run yet)', async () => {
  const findings = await scanDirectoryFiles(join(tmpdir(), 'af-does-not-exist-' + Date.now()));
  assert.deepEqual(findings, []);
});
