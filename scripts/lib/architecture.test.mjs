import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ALLOWED_INTERNAL_DEPENDENCIES,
  importSpecifiers,
  inspectArchitecture,
} from './architecture.mjs';

const root = resolve(import.meta.dirname, '../..');

test('extrai imports estáticos, type-only, export e dinâmicos', () => {
  assert.deepEqual(
    importSpecifiers(
      "import type { A } from '@agent-foundry/a'; export { B } from '@agent-foundry/b'; const c=import('@agent-foundry/c');",
    ),
    ['@agent-foundry/a', '@agent-foundry/b', '@agent-foundry/c'],
  );
});

test('detecta deep import e dependência ausente', async () => {
  const root = await mkdtemp(join(tmpdir(), 'af-arch-'));
  await mkdir(join(root, 'apps/a/src'), { recursive: true });
  await mkdir(join(root, 'packages/b/src'), { recursive: true });
  await writeFile(join(root, 'apps/a/package.json'), JSON.stringify({ name: '@agent-foundry/a' }));
  await writeFile(
    join(root, 'packages/b/package.json'),
    JSON.stringify({ name: '@agent-foundry/b' }),
  );
  await writeFile(join(root, 'apps/a/src/index.ts'), "import '@agent-foundry/b/internal';");
  await writeFile(join(root, 'packages/b/src/index.ts'), 'export {};');
  const allowed = new Map([
    ['@agent-foundry/a', new Set(['@agent-foundry/b'])],
    ['@agent-foundry/b', new Set()],
  ]);
  const result = await inspectArchitecture(root, allowed);
  assert.ok(result.errors.some((error) => error.includes('deep import')));
  assert.ok(result.errors.some((error) => error.includes('não declara')));
});

test('rejeita import de domain pelo web usando a política real', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'af-web-domain-'));
  await mkdir(join(fixtureRoot, 'apps/web/src'), { recursive: true });
  await mkdir(join(fixtureRoot, 'packages/domain/src'), { recursive: true });
  await writeFile(
    join(fixtureRoot, 'apps/web/package.json'),
    JSON.stringify({
      name: '@agent-foundry/web',
      dependencies: { '@agent-foundry/domain': '0.1.0' },
    }),
  );
  await writeFile(
    join(fixtureRoot, 'packages/domain/package.json'),
    JSON.stringify({ name: '@agent-foundry/domain' }),
  );
  await writeFile(join(fixtureRoot, 'apps/web/src/index.ts'), "import '@agent-foundry/domain';");
  await writeFile(join(fixtureRoot, 'packages/domain/src/index.ts'), 'export {};');

  const result = await inspectArchitecture(fixtureRoot, ALLOWED_INTERNAL_DEPENDENCIES);

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.includes('@agent-foundry/web não pode depender de @agent-foundry/domain.'),
  );
});

async function contractsFixture(index, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'af-contracts-'));
  await mkdir(join(root, 'apps'), { recursive: true });
  await mkdir(join(root, 'packages/contracts/src'), { recursive: true });
  await writeFile(
    join(root, 'packages/contracts/package.json'),
    JSON.stringify({ name: '@agent-foundry/contracts' }),
  );
  await writeFile(join(root, 'packages/contracts/src/index.ts'), index);
  for (const [path, source] of Object.entries(files))
    await writeFile(join(root, 'packages/contracts/src', path), source);
  return root;
}

test('rejeita built-ins Node em todas as formas alcançáveis pelo entrypoint browser', async () => {
  for (const source of [
    "import { createHash } from 'node:crypto';",
    "import { createHash } from 'crypto';",
    "const { createHash } = await import('crypto');",
    "import 'crypto';",
  ]) {
    const result = await inspectArchitecture(
      await contractsFixture("export * from './node-only.js';", { 'node-only.ts': source }),
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes(
          `packages/contracts/src/node-only.ts importa built-in Node no entrypoint browser: ${source.includes('node:') ? 'node:crypto' : 'crypto'}`,
        ),
      ),
    );
  }
});

test('aceita fixture limpa para o entrypoint browser', async () => {
  const result = await inspectArchitecture(
    await contractsFixture('export const browserSafe = true;'),
  );
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('platform is a declared leaf workspace', async () => {
  const result = await inspectArchitecture(root);
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.packages.some(({ manifest }) => manifest.name === '@agent-foundry/platform'));
});
