import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');

test('root provider canary command fails closed without the real-provider opt-in', () => {
  const env = { ...process.env };
  delete env.RUN_REAL_PROVIDER_CANARIES;
  const result = spawnSync('npm', ['run', 'canary:providers', '--silent'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_REAL_PROVIDER_CANARIES=true/);
  assert.doesNotMatch(result.stdout, /"schemaVersion"/);
});

test('--freeze uses the repository baseline destinations and still checks opt-in first', () => {
  const env = { ...process.env };
  delete env.RUN_REAL_PROVIDER_CANARIES;
  const result = spawnSync('npm', ['run', 'canary:providers', '--silent', '--', '--freeze'], {
    cwd: root,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_REAL_PROVIDER_CANARIES=true/);
  assert.doesNotMatch(result.stderr, /requires a report destination path/);
});
