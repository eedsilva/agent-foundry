import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const { scripts } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

test('clean preserves declarations for incremental typecheck', () => {
  assert.doesNotMatch(scripts.clean, /dist-types/);
  assert.match(scripts.clean, /tsbuildinfo/);
  assert.equal(scripts.typecheck, 'tsc -b --pretty false');
});
