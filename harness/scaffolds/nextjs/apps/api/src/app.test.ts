import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app, createNodeHandler } from './app.js';
import worker from './worker.js';

const runtimeEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
} as const;

test('Node and Worker expose the same health contract', async () => {
  const request = new Request('http://localhost/health');
  const nodeResponse = await createNodeHandler(runtimeEnv)(request);
  const workerResponse = await worker.fetch(new Request(request), runtimeEnv);

  assert.equal(nodeResponse.status, 200);
  assert.equal(workerResponse.status, 200);
  assert.deepEqual(await nodeResponse.clone().json(), await workerResponse.json());
  assert.deepEqual(await nodeResponse.json(), { status: 'ok' });
});

test('the shared app is the Worker entry point', () => {
  assert.equal(worker, app);
});
