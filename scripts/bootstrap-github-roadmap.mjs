#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubClient, parseRepository, resolveGitHubToken } from './lib/github-client.mjs';
import {
  createRoadmapIssue,
  parseArgs,
  reconcileIssueBlockers,
  reconcileIssueHierarchy,
  verifyWritableRepository,
} from './lib/github-roadmap.mjs';
import {
  extractMarker,
  issueRecords,
  readJson,
  renderRoadmapBody,
  sha256,
  validateRoadmap,
} from './lib/roadmap.mjs';

function printHelp() {
  console.log(
    `Uso: node scripts/bootstrap-github-roadmap.mjs [--apply] [--reconcile] [--force-drift]\n\nDry-run é o padrão. --apply cria itens ausentes. --reconcile também atualiza campos gerenciados. --force-drift permite substituir body editado manualmente.\n`,
  );
}

const root = resolve(import.meta.dirname, '..');
const specPath = resolve(root, 'planning/roadmap-spec.json');
const projectPath = resolve(root, 'planning/project-spec.json');
const statePath = resolve(root, 'planning/github-state.json');
const options = parseArgs(process.argv.slice(2), {
  onHelp: () => {
    printHelp();
    process.exit(0);
  },
});
const spec = await readJson(specPath);
const project = await readJson(projectPath);
const state = await readJson(statePath);
const validation = validateRoadmap(spec, project);
if (!validation.ok) throw new Error(validation.errors.join('\n'));
const records = issueRecords(spec, project);
const desiredKeys = new Set(records.map((record) => record.key));
const knownKeys = new Set(Object.keys(state.issues ?? {}));
const newRecords = records.filter((record) => !knownKeys.has(record.key));
const retired = [...knownKeys].filter((key) => !desiredKeys.has(key));
const { owner, repo, nameWithOwner } = parseRepository(options.repo ?? spec.repository);

console.log(
  `Roadmap ${spec.schemaVersion}: ${spec.labels.length} labels, ${spec.milestones.length} milestones, ${records.length} issues gerenciadas.`,
);
console.log(
  `Estado conhecido: ${knownKeys.size}; novas: ${newRecords.length}; retiradas da spec: ${retired.length}.`,
);
console.log(`Repositório: ${nameWithOwner}; modo: ${options.apply ? 'APPLY' : 'DRY-RUN'}.`);
for (const milestone of spec.milestones)
  console.log(
    `- ${milestone.title}: 1 epic + ${milestone.tasks.length} tasks · ${milestone.target}/${milestone.commitment}`,
  );
if (!options.apply) {
  console.log('\nNada foi alterado. Para aplicar: npm run github:roadmap:apply');
  process.exit(0);
}

const client = new GitHubClient(resolveGitHubToken(), { delayMs: options.delayMs });
const access = await verifyWritableRepository(client, owner, repo);
console.log(`Autenticado como @${access.viewer.login} (${access.permission}).`);
await ensureLabels(client, owner, repo, spec.labels, options.reconcile);
const milestones = await ensureMilestones(client, owner, repo, spec.milestones, options.reconcile);
const liveIssues = await loadIssues(client, owner, repo);
const issueByKey = new Map();

for (const [key, saved] of Object.entries(state.issues ?? {})) {
  const issue = liveIssues.byNumber.get(saved.number);
  if (issue) issueByKey.set(key, issue);
}
for (const [key, issue] of liveIssues.byMarker) {
  if (!issueByKey.has(key)) issueByKey.set(key, issue);
}

for (const record of records) {
  let issue = issueByKey.get(record.key);
  const milestone = record.milestoneKey ? milestones.get(record.milestoneKey) : null;
  if (!issue && options.adoptExisting) issue = liveIssues.byTitle.get(record.title);
  if (!issue) {
    issue = await createRoadmapIssue(client, owner, repo, record, milestone);
    issueByKey.set(record.key, issue);
    console.log(`issue + #${issue.number} ${record.title}`);
  } else {
    console.log(`issue = #${issue.number} ${record.title}`);
    if (options.reconcile)
      await reconcileIssue(
        client,
        owner,
        repo,
        record,
        issue,
        milestone,
        state.issues?.[record.key],
        options.forceDrift,
      );
  }
  state.issues ??= {};
  state.issues[record.key] = {
    number: issue.number,
    title: record.title,
    lastAppliedBodySha256:
      options.reconcile || !knownKeys.has(record.key)
        ? sha256(record.body)
        : state.issues[record.key]?.lastAppliedBodySha256,
    ...(state.issues[record.key]?.legacyBodySha256
      ? { legacyBodySha256: state.issues[record.key].legacyBodySha256 }
      : {}),
  };
}

await reconcileIssueHierarchy(client, owner, repo, records, issueByKey);
await reconcileIssueBlockers(client, owner, repo, records, issueByKey);

const rootRecord = records[0];
const linkedRootBody = renderRoadmapBody(spec, issueByKey);
const rootIssue = issueByKey.get('roadmap');
if (rootIssue && linkedRootBody !== rootRecord.body) {
  const saved = state.issues.roadmap;
  const live = await client.request(`/repos/${owner}/${repo}/issues/${rootIssue.number}`);
  assertNoUnexpectedDrift(live.body ?? '', saved, options.forceDrift, 'roadmap');
  await client.request(`/repos/${owner}/${repo}/issues/${rootIssue.number}`, {
    method: 'PATCH',
    body: { body: linkedRootBody },
  });
  saved.lastAppliedBodySha256 = sha256(linkedRootBody);
}

state.appliedSpecVersion = spec.schemaVersion;
state.appliedAt = new Date().toISOString();
state.repository = nameWithOwner;
await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(
  `\nRoadmap reconciliado: https://github.com/${owner}/${repo}/issues/${issueByKey.get('roadmap').number}`,
);

async function ensureLabels(client, ownerName, repoName, desired, reconcile) {
  const existing = await client.paginate(`/repos/${ownerName}/${repoName}/labels`);
  const map = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  for (const label of desired) {
    const current = map.get(label.name.toLowerCase());
    if (!current) {
      const created = await client.request(`/repos/${ownerName}/${repoName}/labels`, {
        method: 'POST',
        body: label,
      });
      map.set(label.name.toLowerCase(), created);
      console.log(`label + ${label.name}`);
    } else if (
      reconcile &&
      (current.color.toLowerCase() !== label.color.toLowerCase() ||
        (current.description ?? '') !== label.description)
    ) {
      const updated = await client.request(
        `/repos/${ownerName}/${repoName}/labels/${encodeURIComponent(current.name)}`,
        {
          method: 'PATCH',
          body: { new_name: label.name, color: label.color, description: label.description },
        },
      );
      map.set(label.name.toLowerCase(), updated);
      console.log(`label ~ ${label.name}`);
    }
  }
  return map;
}

async function ensureMilestones(client, ownerName, repoName, desired, reconcile) {
  const existing = await client.paginate(`/repos/${ownerName}/${repoName}/milestones?state=all`);
  const map = new Map();
  for (const milestone of desired) {
    let current = existing.find((item) => item.title === milestone.title);
    if (!current && milestone.key !== 'foundation')
      current = existing.find((item) => item.title.startsWith(`${milestone.key} - `));
    if (!current) {
      current = await client.request(`/repos/${ownerName}/${repoName}/milestones`, {
        method: 'POST',
        body: { title: milestone.title, description: milestone.description, state: 'open' },
      });
      console.log(`milestone + ${milestone.title}`);
    } else if (
      reconcile &&
      (current.title !== milestone.title || (current.description ?? '') !== milestone.description)
    ) {
      current = await client.request(
        `/repos/${ownerName}/${repoName}/milestones/${current.number}`,
        {
          method: 'PATCH',
          body: { title: milestone.title, description: milestone.description, state: 'open' },
        },
      );
      console.log(`milestone ~ ${milestone.title}`);
    }
    map.set(milestone.key, current);
  }
  return map;
}

async function loadIssues(client, ownerName, repoName) {
  const issues = await client.paginate(`/repos/${ownerName}/${repoName}/issues?state=all`);
  const byNumber = new Map();
  const byMarker = new Map();
  const byTitle = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    byNumber.set(issue.number, issue);
    byTitle.set(issue.title, issue);
    const key = extractMarker(issue.body ?? '');
    if (key) byMarker.set(key, issue);
  }
  return { byNumber, byMarker, byTitle };
}

function assertNoUnexpectedDrift(liveBody, saved, force, key) {
  if (!saved || force) return;
  const liveHash = sha256(liveBody);
  const accepted = new Set([saved.lastAppliedBodySha256, saved.legacyBodySha256].filter(Boolean));
  if (accepted.size && !accepted.has(liveHash))
    throw new Error(
      `Drift manual detectado em ${key} (#${saved.number}). Revise a edição ou use --force-drift conscientemente.`,
    );
}

async function reconcileIssue(client, ownerName, repoName, record, issue, milestone, saved, force) {
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
