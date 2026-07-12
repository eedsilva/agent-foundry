export async function verifyWritableRepository(client, owner, repo) {
  const viewer = await client.request('/user');
  const repository = await client.request(`/repos/${owner}/${repo}`);
  if (!repository.has_issues) throw new Error('Repositório ausente ou issues desabilitadas.');
  const permission = repository.permissions?.admin
    ? 'ADMIN'
    : repository.permissions?.maintain
      ? 'MAINTAIN'
      : repository.permissions?.push
        ? 'WRITE'
        : repository.permissions?.triage
          ? 'TRIAGE'
          : 'READ';
  if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission))
    throw new Error(`Permissão insuficiente: ${permission}`);
  return { viewer, repository, permission };
}

export async function createRoadmapIssue(client, owner, repo, record, milestone) {
  return client.request(`/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: {
      title: record.title,
      body: record.body,
      labels: record.labels,
      ...(milestone?.number ? { milestone: milestone.number } : {}),
    },
  });
}

export async function getIssueParent(client, owner, repo, issueNumber) {
  try {
    return await client.request(`/repos/${owner}/${repo}/issues/${issueNumber}/parent`);
  } catch (error) {
    if (/\b404\b/.test(String(error?.message ?? error))) return null;
    throw error;
  }
}

export async function reconcileIssueHierarchy(client, owner, repo, desired, issueByKey) {
  for (const record of desired) {
    if (!record.parentKey) continue;
    const issue = issueByKey.get(record.key);
    const parent = issueByKey.get(record.parentKey);
    if (!Number.isInteger(issue?.id) || !Number.isInteger(parent?.number)) continue;
    const currentParent = await getIssueParent(client, owner, repo, issue.number);
    if (currentParent?.number === parent.number) continue;
    await client.request(`/repos/${owner}/${repo}/issues/${parent.number}/sub_issues`, {
      method: 'POST',
      body: { sub_issue_id: issue.id, replace_parent: true },
    });
  }
}

export async function reconcileIssueBlockers(client, owner, repo, desired, issueByKey) {
  const managedIds = new Map(
    [...issueByKey.entries()]
      .filter(([, issue]) => Number.isInteger(issue.id))
      .map(([key, issue]) => [issue.id, key]),
  );
  for (const record of desired) {
    const issue = issueByKey.get(record.key);
    if (!Number.isInteger(issue?.number)) continue;
    const current = await client.paginate(
      `/repos/${owner}/${repo}/issues/${issue.number}/dependencies/blocked_by`,
    );
    const wantedKeys = new Set(record.blockedBy ?? []);
    const currentManaged = new Map(
      current
        .filter((blocker) => managedIds.has(blocker.id))
        .map((blocker) => [managedIds.get(blocker.id), blocker]),
    );
    for (const key of wantedKeys) {
      if (currentManaged.has(key)) continue;
      const blocker = issueByKey.get(key);
      if (!Number.isInteger(blocker?.id))
        throw new Error(`Blocker ausente: ${record.key} <- ${key}`);
      await client.request(
        `/repos/${owner}/${repo}/issues/${issue.number}/dependencies/blocked_by`,
        { method: 'POST', body: { issue_id: blocker.id } },
      );
    }
    for (const [key, blocker] of currentManaged) {
      if (wantedKeys.has(key)) continue;
      await client.request(
        `/repos/${owner}/${repo}/issues/${issue.number}/dependencies/blocked_by/${blocker.id}`,
        { method: 'DELETE' },
      );
    }
  }
}
