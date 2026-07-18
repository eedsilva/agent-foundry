import { sha256 } from './roadmap.mjs';

export function parseArgs(argv, { onHelp } = {}) {
  const options = {
    apply: false,
    reconcile: false,
    forceDrift: false,
    adoptExisting: false,
    delayMs: 500,
    repo: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--reconcile') options.reconcile = true;
    else if (arg === '--force-drift') options.forceDrift = true;
    else if (arg === '--adopt-existing') options.adoptExisting = true;
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      onHelp?.();
      return options;
    } else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0)
    throw new Error('--delay-ms inválido.');
  return options;
}

export function assertNoUnexpectedDrift(liveBody, saved, force, key) {
  if (!saved || force) return;
  const liveHash = sha256(liveBody);
  const accepted = new Set([saved.lastAppliedBodySha256, saved.legacyBodySha256].filter(Boolean));
  if (accepted.size && !accepted.has(liveHash))
    throw new Error(
      `Drift manual detectado em ${key} (#${saved.number}). Revise a edição ou use --force-drift conscientemente.`,
    );
}

export async function reconcileIssue(
  client,
  ownerName,
  repoName,
  record,
  issue,
  milestone,
  saved,
  force,
) {
  const live = await client.request(`/repos/${ownerName}/${repoName}/issues/${issue.number}`);
  if ((live.body ?? '') !== record.body)
    assertNoUnexpectedDrift(live.body ?? '', saved, force, record.key);
  await client.request(`/repos/${ownerName}/${repoName}/issues/${issue.number}`, {
    method: 'PATCH',
    body: {
      title: record.title,
      body: record.body,
      labels: record.labels,
      milestone: milestone?.number ?? null,
    },
  });
}

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
