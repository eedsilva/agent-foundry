import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

const ISSUE_FORM_KEYS = new Set([
  'name',
  'description',
  'about',
  'title',
  'labels',
  'assignees',
  'body',
]);
const MINIMUM_ACTION_MAJORS = new Map([
  ['actions/checkout', 7],
  ['actions/setup-node', 6],
  ['actions/dependency-review-action', 5],
]);

export async function validateGitHubConfiguration(rootDir, roadmapSpec, governanceSpec) {
  const errors = [];
  const warnings = [];
  const labelNames = new Set(roadmapSpec.labels.map((label) => label.name));
  const templateDir = resolve(rootDir, '.github/ISSUE_TEMPLATE');
  const templateFiles = (await readdir(templateDir)).filter(
    (name) => /\.ya?ml$/.test(name) && name !== 'config.yml',
  );

  for (const fileName of templateFiles) {
    const document = await readYaml(join(templateDir, fileName));
    for (const key of Object.keys(document))
      if (!ISSUE_FORM_KEYS.has(key)) errors.push(`${fileName}: chave top-level inválida: ${key}`);
    if (
      !document.name ||
      !(document.description ?? document.about) ||
      !Array.isArray(document.body)
    )
      errors.push(`${fileName}: issue form precisa de name, description/about e body.`);
    for (const label of normalizeLabels(document.labels))
      if (!labelNames.has(label)) errors.push(`${fileName}: label não declarada: ${label}`);
    const ids = new Set();
    for (const entry of document.body ?? []) {
      if (entry.id) {
        if (ids.has(entry.id)) errors.push(`${fileName}: id duplicado: ${entry.id}`);
        ids.add(entry.id);
      }
    }
  }

  const dependabot = await readYaml(resolve(rootDir, '.github/dependabot.yml'));
  for (const update of dependabot.updates ?? []) {
    for (const label of normalizeLabels(update.labels))
      if (!labelNames.has(label)) errors.push(`dependabot.yml: label não declarada: ${label}`);
  }
  const release = await readYaml(resolve(rootDir, '.github/release.yml'));
  for (const category of release.changelog?.categories ?? []) {
    for (const label of normalizeLabels(category.labels))
      if (label !== '*' && !labelNames.has(label))
        errors.push(`release.yml: label não declarada: ${label}`);
  }
  for (const label of normalizeLabels(release.changelog?.exclude?.labels))
    if (!labelNames.has(label)) errors.push(`release.yml: label não declarada: ${label}`);

  const workflowDir = resolve(rootDir, '.github/workflows');
  const workflowFiles = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/.test(name));
  const checkNames = new Set();
  for (const fileName of workflowFiles) {
    const source = await readFile(join(workflowDir, fileName), 'utf8');
    const workflow = YAML.parse(source);
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {}))
      checkNames.add(job.name ?? jobId);
    for (const match of source.matchAll(/uses:\s*([^\s@]+)@v(\d+)/g)) {
      const action = match[1];
      const major = Number(match[2]);
      const minimum = MINIMUM_ACTION_MAJORS.get(action);
      if (minimum && major < minimum)
        warnings.push(`${fileName}: ${action}@v${major} está abaixo do major mínimo v${minimum}.`);
    }
  }
  for (const required of governanceSpec.ruleset.requiredStatusChecks)
    if (!checkNames.has(required)) errors.push(`Ruleset exige check inexistente: ${required}`);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkNames: [...checkNames].sort(),
    files: { templates: templateFiles, workflows: workflowFiles },
  };
}

async function readYaml(path) {
  return YAML.parse(await readFile(path, 'utf8'));
}

function normalizeLabels(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  return [];
}
