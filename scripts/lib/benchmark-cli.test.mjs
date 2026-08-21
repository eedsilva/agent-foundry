import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');

test('benchmark gate rejects invocation model filters', () => {
  const result = spawnSync(
    'npx',
    ['tsx', 'scripts/benchmark.ts', '--gate', '--models', 'claude-haiku'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--gate cannot be combined with --models/);
});
