import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importSpecifiers, inspectArchitecture } from './architecture.mjs';

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
