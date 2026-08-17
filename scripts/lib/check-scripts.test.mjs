import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const { scripts } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

// #574: `npm run check` is the pre-PR gate, so a red bucket has to reach its
// exit code. Three things can break that: a bucket that stops short-circuiting
// (`;` or `|| true` between commands), a runner that reports the failure on
// stdout but exits 0 anyway, and a file list that quietly matches nothing.

// Every root script `check` reaches, walked rather than listed, so a bucket
// added to the chain later is covered without anyone remembering to add it
// here. `npm:<name>` is concurrently's shorthand inside `check:static`. A
// `npm run <name> --workspace <pkg>` call reads as the root `<name>`, which
// only ever widens the set the assertions below run over.
function scriptsReachedBy(entry) {
  const reached = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const name = queue.shift();
    const command = scripts[name];
    if (command === undefined || reached.has(name)) continue;
    reached.add(name);
    for (const [, next] of command.matchAll(/\bnpm(?::|\s+(?:run\s+)?)([\w:.-]+)/g))
      queue.push(next);
  }
  return [...reached];
}

test('clean preserves declarations for incremental typecheck', () => {
  assert.doesNotMatch(scripts.clean, /dist-types/);
  assert.match(scripts.clean, /tsbuildinfo/);
  assert.equal(scripts.typecheck, 'tsc -b --pretty false');
});

test('the check chain reaches the node --test script bucket', () => {
  const chain = scriptsReachedBy('check');
  for (const bucket of ['check:static', 'test', 'test:unit', 'test:scripts', 'build'])
    assert.ok(chain.includes(bucket), `check no longer reaches "${bucket}"`);
});

test('no bucket in the check chain swallows a failure', () => {
  for (const name of scriptsReachedBy('check')) {
    assert.doesNotMatch(scripts[name], /\|\|/, `"${name}" swallows a failure with ||`);
    assert.doesNotMatch(scripts[name], /;/, `"${name}" chains with ; instead of &&`);
  }
});

// Runs the real `test:scripts` command over a fixture holding the one script
// test given, or none at all, so what is under test is the command this repo
// ships rather than a paraphrase of it.
async function runScriptBucket(t, scriptTest) {
  const fixture = await mkdtemp(join(tmpdir(), 'af-574-check-exit-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'scripts/lib'), { recursive: true });
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'af-574-check-exit-fixture',
      private: true,
      scripts: { 'test:scripts': scripts['test:scripts'] },
    }),
  );
  if (scriptTest !== undefined)
    await writeFile(join(fixture, 'scripts/lib/fixture.test.mjs'), scriptTest);

  // `node --test` sets NODE_TEST_CONTEXT in every test child, and a nested
  // runner that inherits it reports to its parent instead of owning its own
  // exit code — it would exit 0 on a failing test and make this vacuous.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  return spawnSync('npm', ['run', 'test:scripts'], { cwd: fixture, env }).status;
}

test('a deliberately failing script test makes the test:scripts bucket exit non-zero', async (t) => {
  // The passing run is the control: without it, a bucket that failed to start
  // at all would satisfy the failing case for the wrong reason.
  const passing = "import test from 'node:test';\ntest('passes', () => {});\n";
  const failing =
    "import test from 'node:test';\ntest('fails', () => {\n  throw new Error('#574 regression fixture');\n});\n";

  assert.equal(await runScriptBucket(t, passing), 0);
  assert.equal(await runScriptBucket(t, failing), 1);
});

test('the test:scripts bucket fails instead of passing when its glob matches nothing', async (t) => {
  // Handed a pattern that matches no file, `node --test` exits 0 and the whole
  // bucket disappears from the gate — hence the guard in front of it.
  assert.notEqual(await runScriptBucket(t), 0);
});
