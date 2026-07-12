import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGitHubConfiguration } from './github-config.mjs';

const roadmap = { labels: [{ name: 'kind:bug' }] };
const governance = { ruleset: { requiredStatusChecks: ['test'] } };

test('detecta label, form key e required check inválidos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-github-'));
  await mkdir(join(root, '.github/ISSUE_TEMPLATE'), { recursive: true });
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(
    join(root, '.github/ISSUE_TEMPLATE/bug.yml'),
    'name: Bug\ndescription: Bug\nunknown: true\nlabels: [missing]\nbody: []\n',
  );
  await writeFile(join(root, '.github/dependabot.yml'), 'version: 2\nupdates: []\n');
  await writeFile(
    join(root, '.github/release.yml'),
    'changelog: {categories: [], exclude: {labels: []}}\n',
  );
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs: {build: {name: build}}\n');
  const result = await validateGitHubConfiguration(root, roadmap, governance);
  assert.ok(result.errors.some((error) => error.includes('chave top-level')));
  assert.ok(result.errors.some((error) => error.includes('label não declarada')));
  assert.ok(result.errors.some((error) => error.includes('check inexistente')));
});
