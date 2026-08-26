import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeHandler, parseItemsQuery } from './app.js';
import worker from './worker.js';

const runtimeEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
} as const;

test('Node and Worker expose identical health contracts', async () => {
  const request = new Request('http://localhost/health');
  const nodeResponse = await createNodeHandler(runtimeEnv)(request);
  const workerResponse = await worker.fetch(new Request(request), runtimeEnv);

  assert.equal(nodeResponse.status, 200);
  assert.equal(workerResponse.status, 200);
  assert.deepEqual(await nodeResponse.clone().json(), await workerResponse.json());
  assert.deepEqual(await nodeResponse.json(), { status: 'ok' });
});

test('Worker rejects missing bindings before the health route', async () => {
  const response = await worker.fetch(new Request('http://localhost/health'), {});

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Worker runtime is not configured.' });
});

test('Items query rejects malformed cursors and bounds page size', () => {
  const invalidCursor = Buffer.from(
    JSON.stringify({ createdAt: '2026-08-26T00:00:00.000Z', id: 'not-a-uuid' }),
  ).toString('base64url');

  assert.deepEqual(parseItemsQuery({ cursor: invalidCursor }), {
    ok: false,
    error: 'Invalid item cursor.',
  });
  assert.deepEqual(parseItemsQuery({}), { ok: true, value: { limit: 25 } });
  assert.equal(parseItemsQuery({ limit: '0' }).ok, false);
  assert.equal(parseItemsQuery({ limit: '101' }).ok, false);
});
