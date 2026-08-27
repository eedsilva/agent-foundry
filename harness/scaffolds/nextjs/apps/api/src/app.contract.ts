import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNodeHandler, parseItemsQuery } from './app.js';
import worker from './worker.js';

const runtimeEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
} as const;

const user = {
  id: '00000000-0000-0000-0000-000000000001',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'owner@example.com',
  email_confirmed_at: '2026-01-01T00:00:00Z',
  phone: '',
  confirmed_at: '2026-01-01T00:00:00Z',
  last_sign_in_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  is_anonymous: false,
};

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
  const impossibleDateCursor = Buffer.from(
    JSON.stringify({
      createdAt: '2026-02-31T00:00:00Z',
      id: '00000000-0000-0000-0000-000000000001',
    }),
  ).toString('base64url');

  assert.deepEqual(parseItemsQuery({ cursor: invalidCursor }), {
    ok: false,
    error: 'Invalid item cursor.',
  });
  assert.deepEqual(parseItemsQuery({ cursor: impossibleDateCursor }), {
    ok: false,
    error: 'Invalid item cursor.',
  });
  assert.deepEqual(parseItemsQuery({}), { ok: true, value: { limit: 25 } });
  assert.equal(parseItemsQuery({ limit: '0' }).ok, false);
  assert.equal(parseItemsQuery({ limit: '101' }).ok, false);
});

const invalidCursorCases = [
  { name: 'malformed UUID', value: { createdAt: '2026-08-26T00:00:00.000Z', id: 'not-a-uuid' } },
  {
    name: 'impossible calendar date',
    value: {
      createdAt: '2026-02-31T00:00:00Z',
      id: '00000000-0000-0000-0000-000000000001',
    },
  },
] as const;

for (const { name, value } of invalidCursorCases) {
  test(`GET /items returns HTTP 400 for an invalid cursor: ${name}`, async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.includes('/auth/v1/user')) {
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    try {
      const cursor = Buffer.from(JSON.stringify(value)).toString('base64url');
      const response = await createNodeHandler(runtimeEnv)(
        new Request(`http://localhost/items?cursor=${cursor}`, {
          headers: { authorization: 'Bearer test-token' },
        }),
      );

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid item cursor.' });
      assert.equal(
        requests.some((url) => url.includes('/rest/v1/items')),
        false,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}

test('GET /items returns a bounded page and advances with its cursor', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const rows = [
    {
      id: '00000000-0000-0000-0000-000000000001',
      title: 'First',
      created_at: '2026-08-26T00:01:00.123456+00:00',
    },
    {
      id: '00000000-0000-0000-0000-000000000002',
      title: 'Second',
      created_at: '2026-08-26T00:01:00.123456+00:00',
    },
    {
      id: '00000000-0000-0000-0000-000000000003',
      title: 'Third',
      created_at: '2026-08-26T00:01:00.123456+00:00',
    },
  ];
  let itemPage = 0;
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push(url);
    if (url.includes('/auth/v1/user')) {
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/rest/v1/items')) {
      return new Response(JSON.stringify(itemPage++ === 0 ? rows : [rows[2]]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const handler = createNodeHandler(runtimeEnv);
    const firstResponse = await handler(
      new Request('http://localhost/items?limit=2', {
        headers: { authorization: 'Bearer test-token' },
      }),
    );
    const firstBody = (await firstResponse.json()) as {
      items: Array<{ id: string; title: string }>;
      nextCursor: string | null;
    };

    assert.equal(firstResponse.status, 200);
    assert.deepEqual(firstBody.items, [
      { id: rows[0].id, title: rows[0].title },
      { id: rows[1].id, title: rows[1].title },
    ]);
    assert.ok(firstBody.nextCursor);

    const secondResponse = await handler(
      new Request(
        `http://localhost/items?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
        { headers: { authorization: 'Bearer test-token' } },
      ),
    );
    const secondBody = (await secondResponse.json()) as {
      items: Array<{ id: string; title: string }>;
      nextCursor: string | null;
    };

    assert.equal(secondResponse.status, 200);
    assert.deepEqual(secondBody, {
      items: [{ id: rows[2].id, title: rows[2].title }],
      nextCursor: null,
    });
    const itemRequests = requests.filter((url) => url.includes('/rest/v1/items'));
    assert.equal(itemRequests.length, 2);
    assert.match(itemRequests[0], /limit=3/);
    assert.match(itemRequests[1], /created_at\.gt\./);
    assert.match(itemRequests[1], /created_at\.eq\./);
    assert.match(itemRequests[1], /id\.gt\./);
    assert.doesNotMatch(itemRequests[1], /created_at\.gt\.[^,]+,id\.gt\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
