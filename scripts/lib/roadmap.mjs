import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const ROADMAP_MARKER_PREFIX = '<!-- agent-foundry-roadmap:key=';

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function marker(key) {
  return `${ROADMAP_MARKER_PREFIX}${key} -->`;
}

export function extractMarker(body = '') {
  const match = body.match(/<!-- agent-foundry-roadmap:key=([^\s]+) -->/);
  return match?.[1] ?? null;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const bullets = (items = []) => items.map((item) => `- ${item}`).join('\n');
const checklist = (items = []) => items.map((item) => `- [ ] ${item}`).join('\n');
const codeBullets = (items = []) => bullets(items.map((item) => `\`${item}\``));

function unique(values) {
  return [...new Set(values)];
}

function priorityName(labels) {
  const priorities = labels.filter((label) => /^priority:p[0-3]$/.test(label));
  if (priorities.length !== 1) return null;
  return priorities[0].split(':')[1].toUpperCase();
}

function derivedLabels(milestone, labels) {
  const target =
    milestone.target === 'Personal v1'
      ? 'target:personal-v1'
      : milestone.target === 'Hosted v2'
        ? 'target:hosted-v2'
        : 'target:shared';
  const commitment = `commitment:${milestone.commitment.toLowerCase()}`;
  const track = `track:${milestone.track.toLowerCase()}`;
  return unique([...labels, target, commitment, track]);
}

function epicPriority(commitment) {
  if (commitment === 'Now' || commitment === 'Next') return 'priority:p1';
  if (commitment === 'Candidate') return 'priority:p2';
  return 'priority:p3';
}

export function validateRoadmap(spec, projectSpec) {
  const errors = [];
  const labelNames = new Set();
  const milestoneKeys = new Set();
  const taskKeys = new Set();

  for (const label of spec.labels ?? []) {
    if (!label.name) errors.push('Label sem nome.');
    if (labelNames.has(label.name)) errors.push(`Label duplicada: ${label.name}`);
    labelNames.add(label.name);
    if (!/^[0-9a-fA-F]{6}$/.test(label.color ?? ''))
      errors.push(`Cor inválida para ${label.name}: ${label.color}`);
  }

  for (const milestone of spec.milestones ?? []) {
    if (milestoneKeys.has(milestone.key)) errors.push(`Milestone duplicada: ${milestone.key}`);
    milestoneKeys.add(milestone.key);
    const deps = milestone.dependsOn ?? [];
    if (new Set(deps).size !== deps.length)
      errors.push(`Dependência duplicada em ${milestone.key}`);

    for (const task of milestone.tasks ?? []) {
      if (taskKeys.has(task.key)) errors.push(`Task duplicada: ${task.key}`);
      taskKeys.add(task.key);
      const p = task.labels?.filter((label) => /^priority:p[0-3]$/.test(label)) ?? [];
      if (p.length !== 1) errors.push(`${task.key} precisa de exatamente uma priority:p0..p3.`);
      if (
        (milestone.commitment === 'Candidate' || milestone.commitment === 'Exploratory') &&
        p.includes('priority:p0')
      ) {
        errors.push(`${task.key} não pode ser P0 em milestone ${milestone.commitment}.`);
      }
      for (const label of task.labels ?? []) {
        if (!labelNames.has(label)) errors.push(`${task.key} usa label não declarada: ${label}`);
      }
    }
  }

  for (const milestone of spec.milestones ?? []) {
    for (const dependency of milestone.dependsOn ?? []) {
      if (!milestoneKeys.has(dependency))
        errors.push(`${milestone.key} depende de milestone inexistente: ${dependency}`);
    }
    for (const task of milestone.tasks ?? []) {
      for (const dependency of task.dependsOn ?? []) {
        if (!taskKeys.has(dependency))
          errors.push(`${task.key} depende de task inexistente: ${dependency}`);
      }
    }
  }

  detectCycles(
    spec.milestones ?? [],
    (m) => m.key,
    (m) => m.dependsOn ?? [],
    'milestone',
    errors,
  );
  const tasks = (spec.milestones ?? []).flatMap((m) => m.tasks ?? []);
  detectCycles(
    tasks,
    (t) => t.key,
    (t) => t.dependsOn ?? [],
    'task',
    errors,
  );

  const byKey = new Map((spec.milestones ?? []).map((m) => [m.key, m]));
  const reachesHosted = (key, seen = new Set()) => {
    if (seen.has(key)) return false;
    seen.add(key);
    const current = byKey.get(key);
    if (!current) return false;
    if (current.target === 'Hosted v2') return true;
    return (current.dependsOn ?? []).some((dep) => reachesHosted(dep, seen));
  };
  for (const milestone of spec.milestones ?? []) {
    if (
      milestone.target === 'Personal v1' &&
      (milestone.dependsOn ?? []).some((dep) => reachesHosted(dep))
    ) {
      errors.push(`${milestone.key} (Personal v1) depende transitivamente de Hosted v2.`);
    }
  }

  if (projectSpec) {
    const expected = [
      'Status',
      'Commitment',
      'Size',
      'Risk',
      'Confidence',
      'Track',
      'Target',
      'Priority',
      'Evidence',
    ];
    const actual = new Set((projectSpec.fields ?? []).map((field) => field.name));
    for (const field of expected)
      if (!actual.has(field)) errors.push(`Project field ausente: ${field}`);
    if (projectSpec.wipLimits?.['In Progress'] !== 2)
      errors.push('WIP limit de In Progress deve ser 2.');
  }

  return { ok: errors.length === 0, errors };
}

function detectCycles(items, keyOf, dependenciesOf, kind, errors) {
  const map = new Map(items.map((item) => [keyOf(item), item]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const visit = (key) => {
    if (visiting.has(key)) {
      const index = stack.indexOf(key);
      errors.push(`Ciclo de ${kind}: ${[...stack.slice(index), key].join(' -> ')}`);
      return;
    }
    if (visited.has(key) || !map.has(key)) return;
    visiting.add(key);
    stack.push(key);
    for (const dependency of dependenciesOf(map.get(key))) visit(dependency);
    stack.pop();
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of map.keys()) visit(key);
}

function managedNotice() {
  return '> Campos estruturais gerenciados por `planning/roadmap-spec.json`. O reconciliador protege edições manuais inesperadas por hash.';
}

export function renderTaskBody(milestone, task) {
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
    codeBullets(task.touchpoints),
    '',
    '## Critérios de aceite',
    '',
    checklist(task.acceptance),
  ];
  if (task.tests?.length) sections.push('', '## Testes obrigatórios', '', checklist(task.tests));
  if (task.dependsOn?.length)
    sections.push('', '## Dependências lógicas', '', codeBullets(task.dependsOn));
  if (task.outOfScope?.length) sections.push('', '## Fora de escopo', '', bullets(task.outOfScope));
  sections.push(
    '',
    '## Evidência para encerramento',
    '',
    '- [ ] PR ou commit relacionado.',
    '- [ ] Resultado observável anexado: testes, logs, screenshots, trace ou benchmark conforme o caso.',
    '- [ ] Impacto de segurança, migração e rollback avaliados.',
    '- [ ] `docs/DEFINITION_OF_DONE.md` satisfeito.',
    '',
    `**Track:** ${milestone.track}  `,
    `**Target:** ${milestone.target}  `,
    `**Commitment:** ${milestone.commitment}`,
    '',
  );
  return sections.join('\n');
}

export function renderEpicBody(milestone) {
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
  if (milestone.dependsOn?.length)
    sections.push('', '## Bloqueios técnicos reais', '', codeBullets(milestone.dependsOn));
  sections.push(
    '',
    '## Non-goals',
    '',
    bullets(milestone.nonGoals),
    '',
    '## Política de entrega',
    '',
    '- A milestone fecha por critérios de saída, não por uma data inventada.',
    '- Sub-issues exigem evidência e Definition of Done.',
    '- Dependências representam bloqueios técnicos, não uma fila waterfall.',
    '',
    `**Track:** ${milestone.track}  `,
    `**Target:** ${milestone.target}  `,
    `**Commitment:** ${milestone.commitment}  `,
    `**Risk:** ${milestone.risk}`,
    '',
  );
  return sections.join('\n');
}

export function renderRoadmapBody(spec, issueMap = new Map()) {
  const rows = spec.milestones.map((m) => {
    const issue = issueMap.get(`epic-${m.key}`);
    const link = issue ? `[#${issue.number}](${issue.html_url ?? issue.url})` : '`a reconciliar`';
    return `| ${m.title} | ${m.track} | ${m.target} | ${m.commitment} | ${link} | ${(m.dependsOn ?? []).map((d) => `\`${d}\``).join(', ') || '—'} |`;
  });
  return [
    marker('roadmap'),
    managedNotice(),
    '',
    `# ${spec.roadmap.title.replace(/^\[Roadmap\]\s*/, '')}`,
    '',
    '## Personal Builder v1',
    '',
    spec.targets['personal-v1'].promise,
    '',
    bullets(spec.targets['personal-v1'].definition),
    '',
    `**North star:** ${spec.targets['personal-v1'].northStarMetric}`,
    '',
    '## Hosted Platform v2',
    '',
    spec.targets['hosted-v2'].promise,
    '',
    '> Hosted v2 é uma trilha posterior. Ela não bloqueia Personal v1 sem dependência explícita.',
    '',
    '## Grafo de entregas',
    '',
    '| Milestone | Track | Target | Commitment | Epic | Depende de |',
    '|---|---|---|---|---:|---|',
    ...rows,
    '',
    '## Princípios',
    '',
    bullets(spec.principles),
    '',
  ].join('\n');
}

export function issueRecords(spec) {
  const records = [];
  const rootLabels = spec.roadmap.labels;
  records.push({
    key: 'roadmap',
    kind: 'roadmap',
    title: spec.roadmap.title,
    body: renderRoadmapBody(spec),
    labels: rootLabels,
    milestoneKey: null,
    parentKey: null,
    blockedBy: [],
    projectValues: {
      Status: 'Inbox',
      Commitment: 'Now',
      Size: 'XL',
      Risk: 'High',
      Confidence: 'Medium',
      Track: 'Core',
      Target: 'Shared',
      Priority: 'P1',
      Evidence: '',
    },
  });

  for (const milestone of spec.milestones) {
    const epicKey = `epic-${milestone.key}`;
    const ePriority = epicPriority(milestone.commitment);
    records.push({
      key: epicKey,
      kind: 'epic',
      title: `[Epic ${milestone.key}] ${milestone.title.replace(`${milestone.key} - `, '')}`,
      body: renderEpicBody(milestone),
      labels: derivedLabels(milestone, ['kind:epic', ePriority]),
      milestoneKey: milestone.key,
      parentKey: 'roadmap',
      blockedBy: (milestone.dependsOn ?? []).map((key) => `epic-${key}`),
      projectValues: {
        Status: 'Inbox',
        Commitment: milestone.commitment,
        Size: 'XL',
        Risk: milestone.risk,
        Confidence: 'Low',
        Track: milestone.track,
        Target: milestone.target,
        Priority: ePriority.split(':')[1].toUpperCase(),
        Evidence: '',
      },
    });
    for (const task of milestone.tasks) {
      const p = priorityName(task.labels);
      records.push({
        key: task.key,
        kind: 'task',
        title: `[${milestone.key}] ${task.title}`,
        body: renderTaskBody(milestone, task),
        labels: derivedLabels(milestone, task.labels),
        milestoneKey: milestone.key,
        parentKey: epicKey,
        blockedBy: task.dependsOn ?? [],
        projectValues: {
          Status: 'Inbox',
          Commitment: milestone.commitment,
          Size: 'M',
          Risk: milestone.risk,
          Confidence: 'Low',
          Track: milestone.track,
          Target: milestone.target,
          Priority: p,
          Evidence: '',
        },
      });
    }
  }
  return records;
}

export function renderRoadmapMarkdown(spec) {
  const records = issueRecords(spec);
  const counts = new Map();
  for (const m of spec.milestones)
    counts.set(m.target, (counts.get(m.target) ?? 0) + m.tasks.length + 1);
  const lines = [
    '# Agent Foundry Roadmap',
    '',
    '> Gerado de `planning/roadmap-spec.json`. Não edite manualmente.',
    '',
    `Spec: **${spec.schemaVersion}** · Milestones: **${spec.milestones.length}** · Tasks: **${records.filter((r) => r.kind === 'task').length}** · Managed issues: **${records.length}**`,
    '',
    '## Targets',
    '',
    '### Personal Builder v1',
    '',
    spec.targets['personal-v1'].promise,
    '',
    `North star: **${spec.targets['personal-v1'].northStarMetric}**`,
    '',
    '### Hosted Platform v2',
    '',
    spec.targets['hosted-v2'].promise,
    '',
    `North star: **${spec.targets['hosted-v2'].northStarMetric}**`,
    '',
    '## Dependency graph',
    '',
    '```mermaid',
    'flowchart LR',
  ];
  for (const m of spec.milestones) {
    lines.push(`  ${safeId(m.key)}["${m.title}"]`);
    for (const dep of m.dependsOn ?? []) lines.push(`  ${safeId(dep)} --> ${safeId(m.key)}`);
  }
  lines.push('```', '', '## Milestones', '');
  for (const m of spec.milestones) {
    lines.push(
      `### ${m.title}`,
      '',
      `**Track:** ${m.track} · **Target:** ${m.target} · **Commitment:** ${m.commitment} · **Risk:** ${m.risk}`,
      '',
      m.description,
      '',
      `**Objective:** ${m.objective}`,
      '',
      '**Exit criteria**',
      '',
      checklist(m.exitCriteria),
      '',
      '**Tasks**',
      '',
    );
    for (const t of m.tasks) lines.push(`- **${t.key}** · ${priorityName(t.labels)} · ${t.title}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function safeId(value) {
  return `m_${value.replace(/[^a-zA-Z0-9]/g, '_')}`;
}
