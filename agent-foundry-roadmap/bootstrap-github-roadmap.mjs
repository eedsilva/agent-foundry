#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_VERSION = '2026-03-10';
const USER_AGENT = 'agent-foundry-roadmap-bootstrap/1.0';

function parseArgs(argv) {
  const options = {
    apply: false,
    reconcile: false,
    repo: null,
    spec: null,
    delayMs: 600,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--apply':
        options.apply = true;
        break;
      case '--reconcile':
        options.reconcile = true;
        break;
      case '--repo':
        options.repo = argv[++index];
        break;
      case '--spec':
        options.spec = argv[++index];
        break;
      case '--delay-ms':
        options.delayMs = Number(argv[++index]);
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new Error('--delay-ms precisa ser um número não negativo.');
  }
  return options;
}

function printHelp() {
  console.log(`
Uso:
  node bootstrap-github-roadmap.mjs
  node bootstrap-github-roadmap.mjs --apply
  node bootstrap-github-roadmap.mjs --apply --reconcile
  node bootstrap-github-roadmap.mjs --apply --repo owner/repo

Opções:
  --apply        Cria labels, milestones, issues e sub-issues.
  --reconcile    Atualiza título, body, labels e milestone de issues já geradas.
  --repo         Sobrescreve o repositório definido no spec.
  --spec         Caminho para roadmap-spec.json.
  --delay-ms     Intervalo entre mutations. Padrão: 600.
  --help         Exibe esta ajuda.

Autenticação:
  O script usa GH_TOKEN, GITHUB_TOKEN ou "gh auth token".
  Nunca cole tokens em issue bodies, logs ou prompts.
`);
}

function marker(key) {
  return `<!-- agent-foundry-roadmap:key=${key} -->`;
}

function managedNotice() {
  return '> Este item é gerenciado por `roadmap-spec.json`. Use `--reconcile` somente quando quiser substituir os campos gerenciados.';
}

function checklist(items) {
  return items.map((item) => `- [ ] ${item}`).join('\n');
}

function bullets(items) {
  return items.map((item) => `- ${item}`).join('\n');
}

function renderTaskBody(task) {
  const sections = [
    marker(task.key),
    managedNotice(),
    '',
    '## Contexto',
    '',
    task.summary,
    '',
    '## Touchpoints prováveis',
    '',
    bullets(task.touchpoints.map((item) => `\`${item}\``)),
    '',
    '## Critérios de aceite',
    '',
    checklist(task.acceptance),
  ];

  if (task.tests?.length) {
    sections.push('', '## Testes obrigatórios', '', checklist(task.tests));
  }
  if (task.dependsOn?.length) {
    sections.push('', '## Dependências lógicas', '', bullets(task.dependsOn.map((item) => `\`${item}\``)));
  }
  if (task.outOfScope?.length) {
    sections.push('', '## Fora de escopo', '', bullets(task.outOfScope));
  }

  sections.push(
    '',
    '## Definition of done',
    '',
    '- [ ] Código, testes e documentação relevante foram atualizados.',
    '- [ ] A trilha de auditoria e a observabilidade da mudança são suficientes para diagnosticar falhas.',
    '- [ ] Nenhum segredo, dado sensível ou comportamento silenciosamente permissivo foi introduzido.',
    '',
  );

  return sections.join('\n');
}

function renderEpicBody(milestone) {
  const sections = [
    marker(`epic-${milestone.key}`),
    managedNotice(),
    '',
    '## Objetivo',
    '',
    milestone.objective,
    '',
    '## Exit criteria',
    '',
    checklist(milestone.exitCriteria),
  ];

  if (milestone.dependsOn?.length) {
    sections.push('', '## Depende de', '', bullets(milestone.dependsOn.map((item) => `\`${item}\``)));
  }

  sections.push('', '## Non-goals', '', bullets(milestone.nonGoals));
  sections.push(
    '',
    '## Regras da entrega',
    '',
    '- Sub-issues devem ser concluídas com evidência, não apenas com código compilando.',
    '- Qualquer alteração de contrato exige migração ou compatibilidade documentada.',
    '- Riscos de segurança e dados possuem gate determinístico sempre que possível.',
    '- Datas não foram inventadas. A milestone fecha por critérios de saída, não por calendário decorativo.',
    '',
  );

  return sections.join('\n');
}

function renderRoadmapBody(spec, epicIssues = new Map()) {
  const rows = spec.milestones.map((milestone) => {
    const issue = epicIssues.get(milestone.key);
    const epicUrl = issue?.webUrl || issue?.html_url || issue?.url;
    const epic = issue ? `[#${issue.number}](${epicUrl})` : '`a criar`';
    return `| ${milestone.title} | ${epic} | ${milestone.description} |`;
  });

  return [
    marker('roadmap'),
    managedNotice(),
    '',
    '# Agent Foundry → Lovable-class',
    '',
    'Este roadmap não tenta copiar uma marca pixel por pixel. O alvo é uma experiência verificável de ponta a ponta:',
    '',
    bullets(spec.target.definition),
    '',
    '## Sequência de releases',
    '',
    '| Milestone | Epic | Resultado |',
    '|---|---:|---|',
    ...rows,
    '',
    '## Guardrails',
    '',
    '- Cada milestone possui uma epic e sub-issues reais no GitHub.',
    '- A ordem é deliberada: confiabilidade, controle, repositórios, preview, UX, isolamento, escala, inteligência, backend, publicação e SaaS.',
    '- Fine-tuning, dezenas de agentes e Kubernetes não entram antes de evidência de necessidade.',
    '- Due dates ficam vazias até existir capacidade e velocidade observadas.',
    '',
    '## Referências de produto usadas para definir “Lovable-class”',
    '',
    ...spec.target.references.map((url) => `- ${url}`),
    '',
  ].join('\n');
}

function taskTitle(milestone, task) {
  return `[${milestone.key}] ${task.title}`;
}

function epicTitle(milestone) {
  return `[Epic ${milestone.key}] ${milestone.title.replace(`${milestone.key} - `, '')}`;
}

function resolveToken() {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv?.trim()) return fromEnv.trim();

  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    throw new Error(
      'Credencial de escrita ausente. Defina GH_TOKEN/GITHUB_TOKEN ou autentique o GitHub CLI com "gh auth login".',
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class GitHubClient {
  constructor(token, delayMs) {
    this.token = token;
    this.delayMs = delayMs;
  }

  async request(endpoint, options = {}, attempt = 0) {
    const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`;
    const method = options.method || 'GET';
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const message = payload?.message || `${response.status} ${response.statusText}`;
      const retryable =
        response.status === 429 ||
        response.status >= 500 ||
        (response.status === 403 &&
          (message.toLowerCase().includes('secondary rate') ||
            message.toLowerCase().includes('rate limit'))) ||
        (response.status === 422 &&
          (message.toLowerCase().includes('spam') ||
            message.toLowerCase().includes('secondary rate')));

      if (retryable && attempt < 6) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const resetEpoch = Number(response.headers.get('x-ratelimit-reset'));
        const resetDelay = Number.isFinite(resetEpoch) ? Math.max(0, resetEpoch * 1000 - Date.now()) : 0;
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.max(resetDelay, 5_000 * 2 ** attempt);
        console.warn(`GitHub pediu backoff (${response.status}). Nova tentativa após ${delay} ms.`);
        await sleep(delay);
        return this.request(endpoint, options, attempt + 1);
      }

      const details = payload?.errors ? `\n${JSON.stringify(payload.errors, null, 2)}` : '';
      throw new Error(`${method} ${endpoint} falhou: ${response.status} ${message}${details}`);
    }

    if (method !== 'GET') await sleep(this.delayMs);
    return payload;
  }

  async graphql(query, variables) {
    const payload = await this.request('/graphql', {
      method: 'POST',
      body: { query, variables },
    });
    if (payload?.errors?.length) {
      throw new Error(`GraphQL falhou:\n${JSON.stringify(payload.errors, null, 2)}`);
    }
    return payload.data;
  }

  async paginate(endpoint) {
    const results = [];
    let page = 1;
    while (true) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const batch = await this.request(`${endpoint}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Resposta paginada inválida em ${endpoint}`);
      results.push(...batch);
      if (batch.length < 100) break;
      page += 1;
    }
    return results;
  }
}

async function ensureLabels(client, owner, repo, desired, apply) {
  const existing = await client.paginate(`/repos/${owner}/${repo}/labels`);
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));

  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase());
    if (current) continue;

    console.log(`label + ${label.name}`);
    if (!apply) continue;

    const created = await client.request(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: label.name,
        color: label.color,
        description: label.description,
      },
    });
    byName.set(created.name.toLowerCase(), created);
  }

  return byName;
}

async function ensureMilestones(client, owner, repo, desired, apply, reconcile) {
  const existing = await client.paginate(`/repos/${owner}/${repo}/milestones?state=all`);
  const byTitle = new Map(existing.map((milestone) => [milestone.title, milestone]));

  for (const milestone of desired) {
    const current = byTitle.get(milestone.title);
    if (!current) {
      console.log(`milestone + ${milestone.title}`);
      if (!apply) continue;
      const created = await client.request(`/repos/${owner}/${repo}/milestones`, {
        method: 'POST',
        body: {
          title: milestone.title,
          state: 'open',
          description: milestone.description,
        },
      });
      byTitle.set(created.title, created);
      continue;
    }

    if (apply && reconcile && current.description !== milestone.description) {
      console.log(`milestone ~ ${milestone.title}`);
      const updated = await client.request(
        `/repos/${owner}/${repo}/milestones/${current.number}`,
        {
          method: 'PATCH',
          body: { description: milestone.description },
        },
      );
      byTitle.set(updated.title, updated);
    }
  }

  return byTitle;
}

async function loadGeneratedIssues(client, owner, repo) {
  const issues = await client.paginate(`/repos/${owner}/${repo}/issues?state=all`);
  const generated = new Map();

  for (const issue of issues) {
    if (issue.pull_request || typeof issue.body !== 'string') continue;
    const match = issue.body.match(/<!-- agent-foundry-roadmap:key=([^>]+) -->/);
    if (!match) continue;
    generated.set(match[1].trim(), issue);
  }
  return generated;
}

async function getRepository(client, owner, repo) {
  const data = await client.graphql(
    `query RepositoryForRoadmap($owner: String!, $repo: String!) {
      viewer { login }
      repository(owner: $owner, name: $repo) {
        id
        nameWithOwner
        viewerPermission
        hasIssuesEnabled
      }
    }`,
    { owner, repo },
  );

  if (!data.repository) throw new Error(`Repositório ${owner}/${repo} não encontrado.`);
  if (!data.repository.hasIssuesEnabled) throw new Error('Issues estão desabilitadas no repositório.');
  if (!['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE'].includes(data.repository.viewerPermission)) {
    throw new Error(
      `Permissão insuficiente: ${data.repository.viewerPermission}. Sub-issues exigem ao menos triage e criação exige acesso de escrita adequado.`,
    );
  }

  console.log(`Autenticado como @${data.viewer.login} em ${data.repository.nameWithOwner} (${data.repository.viewerPermission}).`);
  return data.repository;
}

async function createIssue(client, input) {
  const data = await client.graphql(
    `mutation CreateRoadmapIssue($input: CreateIssueInput!) {
      createIssue(input: $input) {
        issue {
          id
          number
          title
          url
          body
          parent { id }
        }
      }
    }`,
    { input },
  );
  return {
    node_id: data.createIssue.issue.id,
    number: data.createIssue.issue.number,
    title: data.createIssue.issue.title,
    html_url: data.createIssue.issue.url,
    url: data.createIssue.issue.url,
    body: data.createIssue.issue.body,
    parentNodeId: data.createIssue.issue.parent?.id || null,
  };
}

async function inspectParent(client, issueNodeId) {
  const data = await client.graphql(
    `query RoadmapIssueParent($id: ID!) {
      node(id: $id) {
        ... on Issue {
          id
          parent { id }
        }
      }
    }`,
    { id: issueNodeId },
  );
  return data.node?.parent?.id || null;
}

async function attachParent(client, parentNodeId, issueNodeId) {
  const currentParent = await inspectParent(client, issueNodeId);
  if (currentParent === parentNodeId) return;

  await client.graphql(
    `mutation AttachRoadmapSubIssue($input: AddSubIssueInput!) {
      addSubIssue(input: $input) {
        issue { id }
        subIssue { id }
      }
    }`,
    {
      input: {
        issueId: parentNodeId,
        subIssueId: issueNodeId,
        replaceParent: true,
      },
    },
  );
}

async function ensureIssue({
  client,
  repositoryId,
  owner,
  repo,
  generated,
  key,
  title,
  body,
  labelNames,
  labelsByName,
  milestone,
  parent,
  apply,
  reconcile,
}) {
  let issue = generated.get(key);
  const labelIds = labelNames.map((name) => {
    const label = labelsByName.get(name.toLowerCase());
    if (!label?.node_id) throw new Error(`Label sem node_id: ${name}`);
    return label.node_id;
  });

  if (!issue) {
    console.log(`issue + ${title}`);
    if (!apply) {
      return {
        node_id: `dry-${key}`,
        number: 0,
        url: `https://github.com/${owner}/${repo}/issues`,
        html_url: `https://github.com/${owner}/${repo}/issues`,
      };
    }

    issue = await createIssue(client, {
      repositoryId,
      title,
      body,
      labelIds,
      ...(milestone?.node_id ? { milestoneId: milestone.node_id } : {}),
      ...(parent?.node_id ? { parentIssueId: parent.node_id } : {}),
    });
    generated.set(key, issue);
    return issue;
  }

  issue.url ||= issue.html_url;
  console.log(`issue = #${issue.number} ${title}`);

  if (apply && parent?.node_id) {
    await attachParent(client, parent.node_id, issue.node_id);
  }

  if (apply && reconcile) {
    const desiredMilestone = milestone ? milestone.number : null;
    await client.request(`/repos/${owner}/${repo}/issues/${issue.number}`, {
      method: 'PATCH',
      body: {
        title,
        body,
        labels: labelNames,
        milestone: desiredMilestone,
      },
    });
  }

  return issue;
}

async function addBlockedBy(client, blockedIssue, blockingIssue) {
  try {
    await client.graphql(
      `mutation AddRoadmapDependency($input: AddBlockedByInput!) {
        addBlockedBy(input: $input) {
          issue { id }
          blockingIssue { id }
        }
      }`,
      {
        input: {
          issueId: blockedIssue.node_id,
          blockingIssueId: blockingIssue.node_id,
        },
      },
    );
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    if (message.includes('already') || message.includes('exists')) return;
    throw error;
  }
}

async function updateRoadmapBody(client, owner, repo, roadmapIssue, spec, epicIssues) {
  const body = renderRoadmapBody(spec, epicIssues);
  await client.request(`/repos/${owner}/${repo}/issues/${roadmapIssue.number}`, {
    method: 'PATCH',
    body: { body },
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const specPath = options.spec
    ? path.resolve(options.spec)
    : path.join(scriptDir, 'roadmap-spec.json');
  const spec = JSON.parse(await readFile(specPath, 'utf8'));
  const repositoryName = options.repo || spec.repository;
  const [owner, repo, ...extra] = repositoryName.split('/');
  if (!owner || !repo || extra.length) throw new Error(`Repositório inválido: ${repositoryName}`);

  const taskCount = spec.milestones.reduce((sum, milestone) => sum + milestone.tasks.length, 0);
  const totalIssues = 1 + spec.milestones.length + taskCount;

  console.log(`Plano: ${spec.labels.length} labels, ${spec.milestones.length} milestones, ${totalIssues} issues (${taskCount} sub-issues de trabalho).`);
  console.log(`Repositório: ${owner}/${repo}`);
  console.log(`Modo: ${options.apply ? 'APPLY' : 'DRY-RUN'}`);

  if (!options.apply) {
    for (const milestone of spec.milestones) {
      console.log(`- ${milestone.title}: 1 epic + ${milestone.tasks.length} sub-issues`);
    }
    console.log('\nNada foi alterado. Rode novamente com --apply após revisar o spec.');
    return;
  }

  const token = resolveToken();
  const client = new GitHubClient(token, options.delayMs);
  const repository = await getRepository(client, owner, repo);
  const labelsByName = await ensureLabels(client, owner, repo, spec.labels, true);
  const milestonesByTitle = await ensureMilestones(
    client,
    owner,
    repo,
    spec.milestones,
    true,
    options.reconcile,
  );
  const generated = await loadGeneratedIssues(client, owner, repo);

  const roadmapIssue = await ensureIssue({
    client,
    repositoryId: repository.id,
    owner,
    repo,
    generated,
    key: 'roadmap',
    title: '[Roadmap] Agent Foundry → Lovable-class v1.0',
    body: renderRoadmapBody(spec),
    labelNames: ['kind:roadmap', 'priority:p0'],
    labelsByName,
    milestone: null,
    parent: null,
    apply: true,
    reconcile: options.reconcile,
  });

  const epicIssues = new Map();
  let previousEpic = null;

  for (const milestone of spec.milestones) {
    const githubMilestone = milestonesByTitle.get(milestone.title);
    if (!githubMilestone) throw new Error(`Milestone ausente após ensure: ${milestone.title}`);

    const epic = await ensureIssue({
      client,
      repositoryId: repository.id,
      owner,
      repo,
      generated,
      key: `epic-${milestone.key}`,
      title: epicTitle(milestone),
      body: renderEpicBody(milestone),
      labelNames: ['kind:epic', 'priority:p0'],
      labelsByName,
      milestone: githubMilestone,
      parent: roadmapIssue,
      apply: true,
      reconcile: options.reconcile,
    });
    epicIssues.set(milestone.key, epic);

    if (previousEpic) {
      await addBlockedBy(client, epic, previousEpic);
    }
    previousEpic = epic;

    for (const task of milestone.tasks) {
      await ensureIssue({
        client,
        repositoryId: repository.id,
        owner,
        repo,
        generated,
        key: task.key,
        title: taskTitle(milestone, task),
        body: renderTaskBody(task),
        labelNames: task.labels,
        labelsByName,
        milestone: githubMilestone,
        parent: epic,
        apply: true,
        reconcile: options.reconcile,
      });
    }
  }

  await updateRoadmapBody(client, owner, repo, roadmapIssue, spec, epicIssues);

  console.log('\nRoadmap aplicado com sucesso.');
  console.log(`Roadmap: ${roadmapIssue.webUrl || roadmapIssue.html_url || roadmapIssue.url}`);
  for (const [version, epic] of epicIssues) {
    console.log(`${version}: ${epic.webUrl || epic.html_url || epic.url}`);
  }
}

main().catch((error) => {
  console.error(`\nERRO: ${error.message}`);
  process.exitCode = 1;
});
