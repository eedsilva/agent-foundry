import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const { scripts } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

test('clean preserves declarations for incremental typecheck', () => {
  assert.doesNotMatch(scripts.clean, /dist-types/);
  assert.match(scripts.clean, /tsbuildinfo/);
  assert.equal(scripts.typecheck, 'tsc -b --pretty false');
});

// #574: `npm run check` is the pre-PR gate, so a red bucket has to reach its
// exit code. Two things can break that: a bucket that stops short-circuiting
// (`;` or `|| true` between commands) and a bucket whose runner reports the
// failure on stdout but exits 0 anyway.

const CHECK_CHAIN = [
  'check',
  'check:static',
  'architecture:check',
  'roadmap:check',
  'test',
  'test:unit',
  'test:scripts',
  'build',
  'build:packages',
  'build:apps',
  'secrets:check',
];

test('every bucket in the check chain short-circuits on failure', () => {
  for (const name of CHECK_CHAIN) {
    const command = scripts[name];
    assert.ok(command, `package.json has no "${name}" script`);
    assert.doesNotMatch(command, /\|\|/, `"${name}" swallows a failure with ||`);
    assert.doesNotMatch(command, /;/, `"${name}" chains with ; instead of &&`);
  }
});

test('the check chain still runs the node --test script bucket', () => {
  assert.match(scripts.check, /\bnpm test\b/);
  assert.match(scripts.test, /\bnpm run test:scripts\b/);
});

test('a deliberately failing script test makes the test:scripts bucket exit non-zero', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'af-574-check-exit-'));
  await mkdir(join(fixture, 'scripts/lib'), { recursive: true });
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'af-574-check-exit-fixture',
      private: true,
      scripts: { 'test:scripts': scripts['test:scripts'] },
    }),
  );
  await writeFile(
    join(fixture, 'scripts/lib/deliberate-failure.test.mjs'),
    "import test from 'node:test';\ntest('deliberately fails', () => {\n  throw new Error('#574 regression fixture');\n});\n",
  );

  // `node --test` sets NODE_TEST_CONTEXT in every test child, and a nested
  // runner that inherits it reports to its parent instead of owning its own
  // exit code — it would exit 0 on a failing test and make this test vacuous.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const code = await new Promise((resolvePromise) => {
    execFile('npm', ['run', 'test:scripts'], { cwd: fixture, env }, (error) =>
      resolvePromise(error ? (error.code ?? 1) : 0),
    );
  });

  assert.notEqual(code, 0, 'test:scripts reported success on a failing script test');
});
