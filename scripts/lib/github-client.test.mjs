import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, nextLink } from './github-client.mjs';

test('extrai somente a relação next do Link header', () => {
  assert.equal(
    nextLink(
      '<https://api.github.test/items?after=abc>; rel="next", <https://api.github.test/items>; rel="first"',
    ),
    'https://api.github.test/items?after=abc',
  );
  assert.equal(nextLink(null), null);
});

test('paginação segue Link cursor e não inventa page para Projects', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length === 1)
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: {
          'content-type': 'application/json',
          link: '<https://api.github.test/users/e/projectsV2/1/items?after=cursor&per_page=100>; rel="next"',
        },
      });
    return new Response(JSON.stringify([{ id: 2 }]), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new GitHubClient('token', { delayMs: 0 });
  const items = await client.paginate('/users/e/projectsV2/1/items?fields=1,2');
  assert.deepEqual(items, [{ id: 1 }, { id: 2 }]);
  assert.equal(
    calls[0],
    'https://api.github.com/users/e/projectsV2/1/items?fields=1,2&per_page=100',
  );
  assert.equal(
    calls[1],
    'https://api.github.test/users/e/projectsV2/1/items?after=cursor&per_page=100',
  );
});
