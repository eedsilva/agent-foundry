#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GitHubClient, parseRepository, resolveGitHubToken } from './lib/github-client.mjs';
import {
  ensureProjectFields,
  ensureProjectRepositoryLink,
  ensureProjectViews,
  reconcileProjectItems,
} from './lib/github-governance.mjs';
import { buildRulesetPayload, repoSettingsPayload } from './lib/governance.mjs';
import { issueRecords, readJson, validateRoadmap } from './lib/roadmap.mjs';

function parseArgs(argv) {
  const options = {
    apply: false,
    reconcile: false,
    activateRuleset: false,
    publishRelease: false,
    releaseTarget: null,
    delayMs: 400,
    repo: null,
    pruneFieldOptions: false,
    skipProject: false,
    skipViews: false,
    skipRuleset: false,
    skipRepositorySettings: false,
    skipSecurity: false,
    skipRelease: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--reconcile') options.reconcile = true;
    else if (arg === '--activate-ruleset') options.activateRuleset = true;
    else if (arg === '--publish-release') options.publishRelease = true;
    else if (arg === '--release-target') options.releaseTarget = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i]);
    else if (arg === '--prune-field-options') options.pruneFieldOptions = true;
    else if (arg === '--skip-project') options.skipProject = true;
    else if (arg === '--skip-views') options.skipViews = true;
    else if (arg === '--skip-ruleset') options.skipRuleset = true;
    else if (arg === '--skip-repository-settings') options.skipRepositorySettings = true;
    else if (arg === '--skip-security') options.skipSecurity = true;
    else if (arg === '--skip-release') options.skipRelease = true;
    else if (arg === '--help' || arg === '-h') {
      help();
      process.exit(0);
    } else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return options;
}

function help() {
  console.log(
    `Uso: node scripts/bootstrap-github-governance.mjs [--apply] [--reconcile]\n\nO dry-run é padrão. O ruleset novo nasce disabled; use --activate-ruleset somente depois que todos os checks existirem. A release exige --publish-release e target explícito ou o SHA versionado. Opções de single-select externas são preservadas por padrão; --prune-field-options remove as que não estão na spec.\n`,
  );
}

const root = resolve(import.meta.dirname, '..');
const options = parseArgs(process.argv.slice(2));
const roadmap = await readJson(resolve(root, 'planning/roadmap-spec.json'));
const projectSpec = await readJson(resolve(root, 'planning/project-spec.json'));
const governance = await readJson(resolve(root, 'planning/governance-spec.json'));
const state = await readJson(resolve(root, 'planning/github-state.json'));
const valid = validateRoadmap(roadmap, projectSpec);
if (!valid.ok) throw new Error(valid.errors.join('\n'));
const records = issueRecords(roadmap, projectSpec);
const stateIssueCount = Object.keys(state.issues ?? {}).filter((key) =>
  records.some((record) => record.key === key),
).length;
const missingState = records.length - stateIssueCount;
const { owner, repo, nameWithOwner } = parseRepository(options.repo ?? governance.repository);

console.log(`Governança para ${nameWithOwner}; modo ${options.apply ? 'APPLY' : 'DRY-RUN'}.`);
console.log(
  `Project: ${projectSpec.fields.length} fields, ${projectSpec.views.length} views, ${records.length} itens.`,
);
console.log(
  `Ruleset: ${governance.ruleset.requiredStatusChecks.length} checks; ativação explícita: ${options.activateRuleset ? 'sim' : 'não'}.`,
);
console.log(`Roadmap state: ${stateIssueCount}/${records.length}; faltam ${missingState}.`);
console.log(
  `Release ${governance.release.tag}: ${options.publishRelease ? 'publicar' : 'não publicar sem flag explícita'}.`,
);
if (!options.apply) {
  console.log(
    '\nNada foi alterado. Ordem recomendada: roadmap --apply --reconcile, governance --apply --reconcile, executar CI, depois ativar ruleset e publicar release.',
  );
  process.exit(0);
}
if (!options.skipProject && missingState > 0)
  throw new Error(
    `Roadmap ainda não reconciliado: ${missingState} issue keys sem número. Execute github:roadmap:apply primeiro.`,
  );

const client = new GitHubClient(resolveGitHubToken(), { delayMs: options.delayMs });
const repository = await client.request(`/repos/${owner}/${repo}`);
const viewer = await client.request('/user');
const canWrite = Boolean(
  repository.permissions?.admin || repository.permissions?.maintain || repository.permissions?.push,
);
if (!canWrite) throw new Error('Permissão de escrita insuficiente no repositório.');

const needsAdmin = !options.skipRepositorySettings || !options.skipSecurity || !options.skipRuleset;
if (needsAdmin && !repository.permissions?.admin)
  throw new Error(
    'As operações de repository settings, security e ruleset exigem permissão admin. Use as flags --skip-* para aplicar somente Project/release ou autentique uma conta admin.',
  );

if (!options.skipProject)
  await ensureProject(
    client,
    viewer,
    repository,
    owner,
    repo,
    projectSpec,
    records,
    state,
    options,
  );
if (!options.skipRepositorySettings)
  await client.request(`/repos/${owner}/${repo}`, {
    method: 'PATCH',
    body: repoSettingsPayload(governance.repositorySettings),
  });
if (!options.skipSecurity) await ensureSecurity(client, owner, repo, governance.security);
if (!options.skipRuleset) await ensureRuleset(client, owner, repo, governance.ruleset, options);
if (!options.skipRelease && options.publishRelease)
  await ensureRelease(client, owner, repo, governance.release, options.releaseTarget);

console.log(
  '\nGovernança aplicada. Revise planning/PROJECT_AUTOMATIONS.md para ativar os workflows nativos do Project que a API não expõe como configuração reproduzível.',
);

async function ensureProject(
  client,
  viewer,
  repository,
  ownerName,
  repoName,
  spec,
  desiredRecords,
  roadmapState,
  opts,
) {
  if (String(viewer.login).toLowerCase() !== String(spec.owner).toLowerCase())
    throw new Error(
      `A spec cria um Project pessoal de ${spec.owner}, mas a credencial ativa pertence a ${viewer.login}.`,
    );

  const projects = await client.paginate(`/users/${encodeURIComponent(spec.owner)}/projectsV2`);
  let project = projects.find((item) => item.title === spec.title);
  let projectCreated = false;
  if (!project) {
    const ownerData = await client.graphql(`query($login:String!){user(login:$login){id}}`, {
      login: spec.owner,
    });
    const created = await client.graphql(
      `mutation($input:CreateProjectV2Input!){createProjectV2(input:$input){projectV2{id number url title}}}`,
      {
        input: {
          ownerId: ownerData.user.id,
          repositoryId: repository.node_id,
          title: spec.title,
        },
      },
    );
    project = {
      node_id: created.createProjectV2.projectV2.id,
      number: created.createProjectV2.projectV2.number,
      title: created.createProjectV2.projectV2.title,
      html_url: created.createProjectV2.projectV2.url,
    };
    projectCreated = true;
    console.log(`project + ${project.html_url}`);
  }

  if (!project.node_id) {
    const result = await client.graphql(
      `query($login:String!,$number:Int!){user(login:$login){projectV2(number:$number){id number url title}}}`,
      { login: spec.owner, number: project.number },
    );
    const node = result.user?.projectV2;
    if (!node) throw new Error(`Project ${spec.title} não foi encontrado via GraphQL.`);
    project = { ...project, node_id: node.id, html_url: project.html_url ?? node.url };
  }

  if (projectCreated || opts.reconcile) {
    await client.graphql(
      `mutation($input:UpdateProjectV2Input!){updateProjectV2(input:$input){projectV2{id}}}`,
      {
        input: {
          projectId: project.node_id,
          title: spec.title,
          shortDescription: spec.shortDescription,
          readme: spec.readme,
          public: spec.public,
        },
      },
    );
  }

  const linked = await ensureProjectRepositoryLink(client, project.node_id, repository.node_id);
  if (linked) console.log('project repository link +');

  const { fieldsByName, changes: fieldChanges } = await ensureProjectFields(
    client,
    {
      owner: spec.owner,
      projectNumber: project.number,
      desiredFields: spec.fields,
    },
    {
      reconcile: opts.reconcile,
      prune: projectCreated || opts.pruneFieldOptions,
    },
  );
  for (const change of fieldChanges)
    console.log(
      `project field ${change.type === 'created' ? '+' : '~'} ${change.name}${change.pruned ? ' (pruned)' : ''}`,
    );

  if (!opts.skipViews) {
    const createdViews = await ensureProjectViews(client, {
      owner: spec.owner,
      projectNumber: project.number,
      projectId: project.node_id,
      desiredViews: spec.views,
    });
    for (const name of createdViews) console.log(`project view + ${name}`);
  }

  const itemChanges = await reconcileProjectItems(client, {
    projectOwner: spec.owner,
    projectNumber: project.number,
    projectId: project.node_id,
    repositoryOwner: ownerName,
    repositoryName: repoName,
    fieldsByName,
    desiredRecords,
    roadmapState,
  });
  for (const change of itemChanges) {
    if (change.type === 'added') console.log(`project item + #${change.issueNumber}`);
    if (change.type === 'reused') console.log(`project item = #${change.issueNumber} (já existia)`);
  }
}

async function ensureRuleset(client, ownerName, repoName, config, opts) {
  const rulesets = await client.paginate(`/repos/${ownerName}/${repoName}/rulesets`);
  const existing = rulesets.find((item) => item.name === config.name);
  const payload = buildRulesetPayload(config, {
    activate: opts.activateRuleset,
    currentEnforcement: existing?.enforcement ?? null,
  });
  if (!existing) {
    await client.request(`/repos/${ownerName}/${repoName}/rulesets`, {
      method: 'POST',
      body: payload,
    });
    console.log(`ruleset + ${config.name} (${payload.enforcement})`);
  } else if (opts.reconcile || opts.activateRuleset) {
    await client.request(`/repos/${ownerName}/${repoName}/rulesets/${existing.id}`, {
      method: 'PUT',
      body: payload,
    });
    console.log(`ruleset ~ ${config.name} (${payload.enforcement})`);
  }
}

async function ensureSecurity(client, ownerName, repoName, config) {
  if (config.enableVulnerabilityAlerts)
    await client.request(`/repos/${ownerName}/${repoName}/vulnerability-alerts`, {
      method: 'PUT',
      accept: 'application/vnd.github+json',
    });
  if (config.enableAutomatedSecurityFixes)
    await client.request(`/repos/${ownerName}/${repoName}/automated-security-fixes`, {
      method: 'PUT',
    });
}

async function ensureRelease(client, ownerName, repoName, config, targetOverride) {
  const releases = await client.paginate(`/repos/${ownerName}/${repoName}/releases`);
  if (releases.some((release) => release.tag_name === config.tag)) {
    console.log(`release = ${config.tag}`);
    return;
  }
  const body = await readFile(resolve(root, config.bodyPath), 'utf8');
  const target = targetOverride ?? config.target;
  if (!/^[0-9a-f]{40}$/.test(target))
    throw new Error('Release target precisa ser SHA completo explícito.');
  await client.request(`/repos/${ownerName}/${repoName}/releases`, {
    method: 'POST',
    body: {
      tag_name: config.tag,
      target_commitish: target,
      name: config.name,
      body,
      draft: config.draft,
      prerelease: config.prerelease,
    },
  });
  console.log(`release + ${config.tag} @ ${target}`);
}
