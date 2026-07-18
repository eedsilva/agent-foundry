import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoUnexpectedDrift,
  createRoadmapIssue,
  getIssueParent,
  parseArgs,
  reconcileIssue,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './github-roadmap.mjs';
import { sha256 } from './roadmap.mjs';

function fakeClient({ responses = new Map(), paginated = new Map() } = {}) {
  const calls = [];
  return {
    calls,
    async request(endpoint, options = {}) {
      calls.push({ endpoint, options });
      const key = `${options.method ?? 'GET'} ${endpoint}`;
      const response = responses.get(key) ?? responses.get(endpoint);
      if (response instanceof Error) throw response;
      return structuredClone(response ?? {});
    },
    async paginate(endpoint) {
      calls.push({ endpoint, paginate: true });
      return structuredClone(paginated.get(endpoint) ?? []);
    },
  };
}

test('verifica acesso de escrita sem depender de GraphQL', async () => {
  const client = fakeClient({
    responses: new Map([
      ['/user', { login: 'eed' }],
      ['/repos/eedsilva/agent-foundry', { has_issues: true, permissions: { push: true } }],
    ]),
  });
  const result = await verifyWritableRepository(client, 'eedsilva', 'agent-foundry');
  assert.equal(result.viewer.login, 'eed');
  assert.equal(result.permission, 'WRITE');
});

test('cria issue com labels e milestone pelo endpoint REST', async () => {
  const client = fakeClient({
    responses: new Map([['POST /repos/o/r/issues', { id: 42, number: 7 }]]),
  });
  const issue = await createRoadmapIssue(
    client,
    'o',
    'r',
    { title: 'Título', body: 'Body', labels: ['type:task'] },
    { number: 3 },
  );
  assert.equal(issue.number, 7);
  assert.deepEqual(client.calls[0], {
    endpoint: '/repos/o/r/issues',
    options: {
      method: 'POST',
      body: { title: 'Título', body: 'Body', labels: ['type:task'], milestone: 3 },
    },
  });
});

test('404 de parent significa issue ainda sem pai', async () => {
  const client = fakeClient({
    responses: new Map([['/repos/o/r/issues/2/parent', new Error('GET endpoint: 404 Not Found')]]),
  });
  assert.equal(await getIssueParent(client, 'o', 'r', 2), null);
});

test('hierarquia preserva pai correto e adiciona apenas o ausente', async () => {
  const client = fakeClient({
    responses: new Map([
      ['/repos/o/r/issues/2/parent', { number: 1 }],
      ['/repos/o/r/issues/3/parent', new Error('GET endpoint: 404 Not Found')],
      ['POST /repos/o/r/issues/1/sub_issues', { id: 1 }],
    ]),
  });
  const records = [
    { key: 'root' },
    { key: 'child-ok', parentKey: 'root' },
    { key: 'child-new', parentKey: 'root' },
  ];
  const issues = new Map([
    ['root', { id: 10, number: 1 }],
    ['child-ok', { id: 20, number: 2 }],
    ['child-new', { id: 30, number: 3 }],
  ]);
  await reconcileIssueHierarchy(client, 'o', 'r', records, issues);
  const posts = client.calls.filter((call) => call.options?.method === 'POST');
  assert.deepEqual(posts, [
    {
      endpoint: '/repos/o/r/issues/1/sub_issues',
      options: { method: 'POST', body: { sub_issue_id: 30, replace_parent: true } },
    },
  ]);
});

test('dependências adicionam ausentes, removem stale gerenciadas e preservam externas', async () => {
  const endpoint = '/repos/o/r/issues/3/dependencies/blocked_by';
  const client = fakeClient({
    paginated: new Map([
      [
        endpoint,
        [
          { id: 20, number: 2 },
          { id: 999, number: 99 },
        ],
      ],
    ]),
  });
  const records = [
    { key: 'a', blockedBy: [] },
    { key: 'b', blockedBy: [] },
    { key: 'c', blockedBy: ['a'] },
  ];
  const issues = new Map([
    ['a', { id: 10, number: 1 }],
    ['b', { id: 20, number: 2 }],
    ['c', { id: 30, number: 3 }],
  ]);
  await reconcileIssueBlockers(client, 'o', 'r', records, issues);
  const writes = client.calls.filter((call) => call.options?.method);
  assert.deepEqual(writes, [
    { endpoint, options: { method: 'POST', body: { issue_id: 10 } } },
    {
      endpoint: `${endpoint}/20`,
      options: { method: 'DELETE' },
    },
  ]);
  assert.equal(
    writes.some((call) => call.endpoint.endsWith('/999')),
    false,
  );
});

test('parseArgs: dry-run é o padrão', () => {
  const options = parseArgs([]);
  assert.deepEqual(options, {
    apply: false,
    reconcile: false,
    forceDrift: false,
    adoptExisting: false,
    delayMs: 500,
    repo: null,
  });
});

test('parseArgs: liga apply, reconcile, force-drift e adopt-existing', () => {
  const options = parseArgs(['--apply', '--reconcile', '--force-drift', '--adopt-existing']);
  assert.equal(options.apply, true);
  assert.equal(options.reconcile, true);
  assert.equal(options.forceDrift, true);
  assert.equal(options.adoptExisting, true);
});

test('parseArgs: aceita --repo e --delay-ms com valor customizado', () => {
  const options = parseArgs(['--repo', 'o/r', '--delay-ms', '10']);
  assert.equal(options.repo, 'o/r');
  assert.equal(options.delayMs, 10);
});

test('parseArgs: rejeita --delay-ms inválido', () => {
  assert.throws(() => parseArgs(['--delay-ms', 'nope']), /--delay-ms inválido/);
  assert.throws(() => parseArgs(['--delay-ms', '-1']), /--delay-ms inválido/);
});

test('parseArgs: rejeita flag desconhecida', () => {
  assert.throws(() => parseArgs(['--bogus']), /Argumento desconhecido: --bogus/);
});

test('assertNoUnexpectedDrift: sem estado salvo, primeira aplicação passa', () => {
  assert.doesNotThrow(() => assertNoUnexpectedDrift('qualquer corpo', undefined, false, 'k'));
});

test('assertNoUnexpectedDrift: hash do corpo ao vivo bate com o último aplicado', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo gerenciado', saved, false, 'k'));
});

test('assertNoUnexpectedDrift: hash do corpo ao vivo bate com o legado', () => {
  const saved = {
    number: 7,
    lastAppliedBodySha256: sha256('corpo novo formato'),
    legacyBodySha256: sha256('corpo formato antigo'),
  };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo formato antigo', saved, false, 'k'));
});

test('assertNoUnexpectedDrift: edição manual inesperada lança erro', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.throws(
    () => assertNoUnexpectedDrift('corpo editado à mão', saved, false, 'minha-task'),
    /Drift manual detectado em minha-task \(#7\)/,
  );
});

test('assertNoUnexpectedDrift: --force-drift ignora a divergência', () => {
  const saved = { number: 7, lastAppliedBodySha256: sha256('corpo gerenciado') };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('corpo editado à mão', saved, true, 'k'));
});

test('assertNoUnexpectedDrift: estado salvo sem hash nenhum ainda não bloqueia', () => {
  const saved = { number: 7 };
  assert.doesNotThrow(() => assertNoUnexpectedDrift('qualquer corpo', saved, false, 'k'));
});

test('reconcileIssue: corpo sem divergência é atualizado normalmente', async () => {
  const record = {
    key: 'task-a',
    title: 'Título',
    body: 'corpo gerenciado',
    labels: ['kind:task'],
  };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo gerenciado') };
  const client = fakeClient({
    responses: new Map([
      ['/repos/o/r/issues/9', { body: 'corpo gerenciado' }],
      ['PATCH /repos/o/r/issues/9', { number: 9 }],
    ]),
  });
  await reconcileIssue(client, 'o', 'r', record, { number: 9 }, { number: 3 }, saved, false);
  const patch = client.calls.find((call) => call.options?.method === 'PATCH');
  assert.deepEqual(patch, {
    endpoint: '/repos/o/r/issues/9',
    options: {
      method: 'PATCH',
      body: { title: 'Título', body: 'corpo gerenciado', labels: ['kind:task'], milestone: 3 },
    },
  });
});

test('reconcileIssue: divergência manual bloqueia o PATCH', async () => {
  const record = { key: 'task-a', title: 'Título', body: 'corpo novo', labels: [] };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo antigo gerenciado') };
  const client = fakeClient({
    responses: new Map([['/repos/o/r/issues/9', { body: 'corpo editado à mão' }]]),
  });
  await assert.rejects(
    () => reconcileIssue(client, 'o', 'r', record, { number: 9 }, null, saved, false),
    /Drift manual detectado em task-a \(#9\)/,
  );
  assert.equal(
    client.calls.some((call) => call.options?.method === 'PATCH'),
    false,
  );
});

test('reconcileIssue: --force-drift aplica o PATCH mesmo com divergência', async () => {
  const record = { key: 'task-a', title: 'Título', body: 'corpo novo', labels: [] };
  const saved = { number: 9, lastAppliedBodySha256: sha256('corpo antigo gerenciado') };
  const client = fakeClient({
    responses: new Map([
      ['/repos/o/r/issues/9', { body: 'corpo editado à mão' }],
      ['PATCH /repos/o/r/issues/9', { number: 9 }],
    ]),
  });
  await reconcileIssue(client, 'o', 'r', record, { number: 9 }, null, saved, true);
  assert.equal(
    client.calls.some((call) => call.options?.method === 'PATCH'),
    true,
  );
});
