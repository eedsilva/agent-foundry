import { fieldValueUpdates, mergeSelectOptions, selectOptionsEqual } from './governance.mjs';

export async function ensureProjectRepositoryLink(client, projectId, repositoryId) {
  const data = await client.graphql(
    `query($id:ID!){node(id:$id){... on ProjectV2{repositories(first:100){nodes{id}}}}}`,
    { id: projectId },
  );
  const linked = data.node?.repositories?.nodes?.some(
    (repository) => repository.id === repositoryId,
  );
  if (linked) return false;
  await client.graphql(
    `mutation($input:LinkProjectV2ToRepositoryInput!){linkProjectV2ToRepository(input:$input){repository{id}}}`,
    { input: { projectId, repositoryId } },
  );
  return true;
}

export async function ensureProjectFields(
  client,
  { owner, projectNumber, desiredFields },
  { reconcile = false, prune = false } = {},
) {
  const endpoint = `/users/${encodeURIComponent(owner)}/projectsV2/${projectNumber}/fields`;
  let fields = await client.paginate(endpoint);
  let fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const changes = [];

  for (const desired of desiredFields) {
    const current = fieldsByName.get(desired.name);
    if (!current) {
      const body = {
        name: desired.name,
        data_type: desired.type.toLowerCase(),
        ...(desired.options ? { single_select_options: desired.options } : {}),
      };
      const created = await client.request(endpoint, { method: 'POST', body });
      fieldsByName.set(created.name, created);
      changes.push({ type: 'created', name: desired.name });
      continue;
    }

    const currentType = String(current.data_type).toUpperCase();
    if (currentType !== desired.type)
      throw new Error(
        `Field ${desired.name} tem tipo ${current.data_type}; a spec exige ${desired.type}. Renomeie o field conflitante ou ajuste a spec.`,
      );

    if (desired.type !== 'SINGLE_SELECT' || !desired.options) continue;
    const merged = mergeSelectOptions(current.options ?? [], desired.options, { prune });
    if (selectOptionsEqual(current.options ?? [], merged)) continue;
    if (!reconcile && !prune)
      throw new Error(
        `Field ${desired.name} diverge da spec. Execute novamente com --reconcile; opções externas serão preservadas por padrão.`,
      );
    if (!current.node_id)
      throw new Error(`Field ${desired.name} não possui node_id para reconciliação GraphQL.`);
    await client.graphql(
      `mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`,
      {
        input: {
          fieldId: current.node_id,
          name: desired.name,
          singleSelectOptions: merged,
        },
      },
    );
    changes.push({ type: 'updated', name: desired.name, pruned: prune });
  }

  fields = await client.paginate(endpoint);
  fieldsByName = new Map(fields.map((field) => [field.name, field]));
  for (const desired of desiredFields)
    if (!fieldsByName.has(desired.name))
      throw new Error(`Field ${desired.name} não foi materializado no Project.`);
  return { fieldsByName, changes };
}

export async function ensureProjectViews(
  client,
  { owner, projectNumber, projectId, desiredViews },
) {
  const result = await client.graphql(
    `query($id:ID!){node(id:$id){... on ProjectV2{views(first:100){nodes{name}}}}}`,
    { id: projectId },
  );
  const existing = new Set(result.node?.views?.nodes?.map((view) => view.name) ?? []);
  const endpoint = `/users/${encodeURIComponent(owner)}/projectsV2/${projectNumber}/views`;
  const created = [];
  for (const view of desiredViews) {
    if (existing.has(view.name)) continue;
    await client.request(endpoint, {
      method: 'POST',
      body: { name: view.name, layout: view.layout, filter: view.filter },
    });
    existing.add(view.name);
    created.push(view.name);
  }
  return created;
}

export function projectItemValues(item) {
  const values = {};
  for (const field of item.fields ?? [])
    values[field.name] = field.value?.name?.raw ?? field.value?.raw ?? field.value ?? '';
  return values;
}

export function projectItemIssueNumber(item) {
  const value = Number(item?.content?.number);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function isDuplicateProjectItemError(error) {
  return /\b422\b.*content already exists in this project/i.test(
    String(error?.message ?? error),
  );
}

async function getExistingProjectItem(
  client,
  { projectId, contentId, itemsEndpoint, fieldsQuery },
) {
  const result = await client.graphql(
    `mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id fullDatabaseId}}}`,
    { projectId, contentId },
  );
  const itemId = result.addProjectV2ItemById?.item?.fullDatabaseId;
  if (!itemId)
    throw new Error(
      'GitHub informou que o conteúdo já existe no Project, mas não retornou fullDatabaseId para recuperá-lo.',
    );
  const item = await client.request(
    `${itemsEndpoint}/${encodeURIComponent(itemId)}${fieldsQuery}`,
  );
  return { ...item, id: itemId };
}

export async function reconcileProjectItems(
  client,
  {
    projectOwner,
    projectNumber,
    projectId,
    repositoryOwner,
    repositoryName,
    fieldsByName,
    desiredRecords,
    roadmapState,
  },
) {
  const fieldIds = [...fieldsByName.values()].map((field) => field.id).filter(Boolean);
  const fieldsQuery = fieldIds.length ? `?fields=${fieldIds.join(',')}` : '';
  const itemsEndpoint = `/users/${encodeURIComponent(projectOwner)}/projectsV2/${projectNumber}/items`;
  const items = await client.paginate(`${itemsEndpoint}${fieldsQuery}`);
  const itemByIssueNumber = new Map(
    items.flatMap((item) => {
      const issueNumber = projectItemIssueNumber(item);
      return issueNumber ? [[issueNumber, item]] : [];
    }),
  );
  const changes = [];

  for (const record of desiredRecords) {
    const issueNumber = Number(roadmapState.issues?.[record.key]?.number);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;
    let item = itemByIssueNumber.get(issueNumber);
    let newItem = false;
    if (!item) {
      const issue = await client.request(
        `/repos/${repositoryOwner}/${repositoryName}/issues/${issueNumber}`,
      );
      try {
        item = await client.request(itemsEndpoint, {
          method: 'POST',
          body: { type: 'Issue', id: issue.id },
        });
        newItem = true;
        changes.push({ type: 'added', issueNumber });
      } catch (error) {
        if (!isDuplicateProjectItemError(error)) throw error;
        if (!projectId || !issue.node_id)
          throw new Error(
            `A issue #${issueNumber} já existe no Project, mas projectId/node_id estão ausentes para recuperá-la.`,
            { cause: error },
          );
        item = await getExistingProjectItem(client, {
          projectId,
          contentId: issue.node_id,
          itemsEndpoint,
          fieldsQuery,
        });
        changes.push({ type: 'reused', issueNumber });
      }
      itemByIssueNumber.set(issueNumber, item);
    }
    const updates = fieldValueUpdates(fieldsByName, projectItemValues(item), record.projectValues, {
      newItem,
    });
    if (!updates.length) continue;
    await client.request(`${itemsEndpoint}/${item.id}`, {
      method: 'PATCH',
      body: { fields: updates },
    });
    changes.push({ type: 'updated', issueNumber, fields: updates.length });
  }
  return changes;
}
