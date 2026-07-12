import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureProjectFields,
  ensureProjectRepositoryLink,
  ensureProjectViews,
  reconcileProjectItems,
} from './github-governance.mjs';

function fakeClient({ responses = new Map(), paginated = new Map(), graphql = [] } = {}) {
  const calls = [];
  const graphqlQueue = [...graphql];
  const paginateCounters = new Map();
  return {
    calls,
    async request(endpoint, options = {}) {
      calls.push({ kind: 'request', endpoint, options });
      const key = `${options.method ?? 'GET'} ${endpoint}`;
      const response = responses.get(key) ?? responses.get(endpoint) ?? {};
      if (response instanceof Error) throw response;
      return structuredClone(response);
    },
    async paginate(endpoint) {
      calls.push({ kind: 'paginate', endpoint });
      const values = paginated.get(endpoint) ?? [];
      if (!Array.isArray(values[0])) return structuredClone(values);
      const index = paginateCounters.get(endpoint) ?? 0;
      paginateCounters.set(endpoint, index + 1);
      return structuredClone(values[Math.min(index, values.length - 1)]);
    },
    async graphql(query, variables) {
      calls.push({ kind: 'graphql', query, variables });
      return structuredClone(graphqlQueue.shift() ?? {});
    },
  };
}

test('liga Project ao repositório somente quando a relação está ausente', async () => {
  const client = fakeClient({
    graphql: [
      { node: { repositories: { nodes: [] } } },
      { linkProjectV2ToRepository: { repository: { id: 'R_1' } } },
    ],
  });
  assert.equal(await ensureProjectRepositoryLink(client, 'P_1', 'R_1'), true);
  assert.deepEqual(client.calls[1].variables, {
    input: { projectId: 'P_1', repositoryId: 'R_1' },
  });

  const linked = fakeClient({
    graphql: [{ node: { repositories: { nodes: [{ id: 'R_1' }] } } }],
  });
  assert.equal(await ensureProjectRepositoryLink(linked, 'P_1', 'R_1'), false);
  assert.equal(linked.calls.length, 1);
});

test('reconcilia Status preservando IDs e opções externas por padrão', async () => {
  const endpoint = '/users/eedsilva/projectsV2/7/fields';
  const before = [
    {
      id: 10,
      node_id: 'PVTF_status',
      name: 'Status',
      data_type: 'single_select',
      options: [
        { id: 'todo', name: { raw: 'Todo' }, color: 'GRAY', description: { raw: '' } },
        {
          id: 'progress',
          name: { raw: 'In Progress' },
          color: 'BLUE',
          description: { raw: 'old' },
        },
        { id: 'done', name: { raw: 'Done' }, color: 'GREEN', description: { raw: '' } },
      ],
    },
  ];
  const after = [
    {
      ...before[0],
      options: [
        { id: 'inbox', name: { raw: 'Inbox' }, color: 'GRAY', description: { raw: 'new' } },
        {
          id: 'progress',
          name: { raw: 'In Progress' },
          color: 'YELLOW',
          description: { raw: 'active' },
        },
        { id: 'done', name: { raw: 'Done' }, color: 'GREEN', description: { raw: 'done' } },
        { id: 'todo', name: { raw: 'Todo' }, color: 'GRAY', description: { raw: '' } },
      ],
    },
  ];
  const client = fakeClient({
    paginated: new Map([[endpoint, [before, after]]]),
    graphql: [{ updateProjectV2Field: { projectV2Field: { id: 'PVTF_status' } } }],
  });
  const desiredFields = [
    {
      name: 'Status',
      type: 'SINGLE_SELECT',
      options: [
        { name: 'Inbox', color: 'GRAY', description: 'new' },
        { name: 'In Progress', color: 'YELLOW', description: 'active' },
        { name: 'Done', color: 'GREEN', description: 'done' },
      ],
    },
  ];
  const result = await ensureProjectFields(
    client,
    { owner: 'eedsilva', projectNumber: 7, desiredFields },
    { reconcile: true },
  );
  assert.deepEqual(result.changes, [{ type: 'updated', name: 'Status', pruned: false }]);
  const mutation = client.calls.find((call) => call.kind === 'graphql');
  assert.deepEqual(
    mutation.variables.input.singleSelectOptions.map(({ id, name }) => ({ id: id ?? null, name })),
    [
      { id: null, name: 'Inbox' },
      { id: 'progress', name: 'In Progress' },
      { id: 'done', name: 'Done' },
      { id: 'todo', name: 'Todo' },
    ],
  );
});

test('cria somente views ausentes', async () => {
  const client = fakeClient({
    graphql: [{ node: { views: { nodes: [{ name: 'Now' }] } } }],
  });
  const created = await ensureProjectViews(client, {
    owner: 'eedsilva',
    projectNumber: 7,
    projectId: 'P_1',
    desiredViews: [
      { name: 'Now', layout: 'board', filter: 'Commitment:Now' },
      { name: 'Next', layout: 'table', filter: 'Commitment:Next' },
    ],
  });
  assert.deepEqual(created, ['Next']);
  const write = client.calls.find((call) => call.kind === 'request');
  assert.deepEqual(write, {
    kind: 'request',
    endpoint: '/users/eedsilva/projectsV2/7/views',
    options: {
      method: 'POST',
      body: { name: 'Next', layout: 'table', filter: 'Commitment:Next' },
    },
  });
});

test('normaliza o número da issue, usa IDs reais de fields e preserva Status humano', async () => {
  const fieldsByName = new Map([
    [
      'Status',
      {
        id: 10,
        data_type: 'single_select',
        options: [
          { id: 'inbox', name: { raw: 'Inbox' } },
          { id: 'progress', name: { raw: 'In Progress' } },
        ],
      },
    ],
    [
      'Target',
      { id: 11, data_type: 'single_select', options: [{ id: 'pv1', name: 'Personal v1' }] },
    ],
  ]);
  const listEndpoint = '/users/eedsilva/projectsV2/7/items?fields=10,11';
  const client = fakeClient({
    paginated: new Map([
      [
        listEndpoint,
        [
          {
            id: 70,
            content: { number: '1' },
            fields: [
              { name: 'Status', value: { name: { raw: 'In Progress' } } },
              { name: 'Target', value: { name: { raw: 'Hosted v2' } } },
            ],
          },
        ],
      ],
    ]),
    responses: new Map([
      ['/repos/eedsilva/agent-foundry/issues/2', { id: 102, number: 2 }],
      ['POST /users/eedsilva/projectsV2/7/items', { id: 71, content: { number: 2 }, fields: [] }],
    ]),
  });
  const changes = await reconcileProjectItems(client, {
    projectOwner: 'eedsilva',
    projectNumber: 7,
    projectId: 'P_1',
    repositoryOwner: 'eedsilva',
    repositoryName: 'agent-foundry',
    fieldsByName,
    desiredRecords: [
      { key: 'one', projectValues: { Status: 'Inbox', Target: 'Personal v1' } },
      { key: 'two', projectValues: { Status: 'Inbox', Target: 'Personal v1' } },
    ],
    roadmapState: { issues: { one: { number: '1' }, two: { number: '2' } } },
  });
  assert.deepEqual(changes, [
    { type: 'updated', issueNumber: 1, fields: 1 },
    { type: 'added', issueNumber: 2 },
    { type: 'updated', issueNumber: 2, fields: 2 },
  ]);
  assert.equal(
    client.calls.some((call) => call.endpoint.includes('fields=*')),
    false,
  );
  const firstPatch = client.calls.find(
    (call) => call.endpoint.endsWith('/items/70') && call.options.method === 'PATCH',
  );
  assert.deepEqual(firstPatch.options.body.fields, [{ id: 11, value: 'pv1' }]);
});

test('recupera item existente quando o REST responde 422 de conteúdo duplicado', async () => {
  const fieldsByName = new Map([
    [
      'Target',
      { id: 10, data_type: 'single_select', options: [{ id: 'pv1', name: 'Personal v1' }] },
    ],
  ]);
  const listEndpoint = '/users/eedsilva/projectsV2/7/items?fields=10';
  const itemsEndpoint = '/users/eedsilva/projectsV2/7/items';
  const duplicate = new Error(
    'POST /users/eedsilva/projectsV2/7/items: 422 Content already exists in this project',
  );
  const client = fakeClient({
    paginated: new Map([[listEndpoint, []]]),
    responses: new Map([
      [
        '/repos/eedsilva/agent-foundry/issues/1',
        { id: 101, node_id: 'I_1', number: 1 },
      ],
      [`POST ${itemsEndpoint}`, duplicate],
      [
        `${itemsEndpoint}/70?fields=10`,
        { id: 70, content: { number: 1 }, fields: [] },
      ],
    ]),
    graphql: [
      {
        addProjectV2ItemById: {
          item: { id: 'PVTI_1', fullDatabaseId: '70' },
        },
      },
    ],
  });

  const changes = await reconcileProjectItems(client, {
    projectOwner: 'eedsilva',
    projectNumber: 7,
    projectId: 'P_1',
    repositoryOwner: 'eedsilva',
    repositoryName: 'agent-foundry',
    fieldsByName,
    desiredRecords: [{ key: 'one', projectValues: { Target: 'Personal v1' } }],
    roadmapState: { issues: { one: { number: 1 } } },
  });

  assert.deepEqual(changes, [
    { type: 'reused', issueNumber: 1 },
    { type: 'updated', issueNumber: 1, fields: 1 },
  ]);
  const mutation = client.calls.find((call) => call.kind === 'graphql');
  assert.deepEqual(mutation.variables, { projectId: 'P_1', contentId: 'I_1' });
  const patch = client.calls.find(
    (call) => call.endpoint === `${itemsEndpoint}/70` && call.options.method === 'PATCH',
  );
  assert.deepEqual(patch.options.body.fields, [{ id: 10, value: 'pv1' }]);
});
