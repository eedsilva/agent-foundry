import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

export const ALLOWED_INTERNAL_DEPENDENCIES = new Map([
  ['@agent-foundry/contracts', new Set()],
  ['@agent-foundry/domain', new Set(['@agent-foundry/contracts'])],
  ['@agent-foundry/persistence', new Set(['@agent-foundry/contracts', '@agent-foundry/domain'])],
  ['@agent-foundry/harness', new Set(['@agent-foundry/domain'])],
  ['@agent-foundry/model-router', new Set(['@agent-foundry/contracts', '@agent-foundry/domain'])],
  ['@agent-foundry/executors', new Set(['@agent-foundry/contracts', '@agent-foundry/domain'])],
  ['@agent-foundry/platform', new Set(['@agent-foundry/contracts', '@agent-foundry/domain'])],
  ['@agent-foundry/orchestrator', new Set(['@agent-foundry/contracts', '@agent-foundry/domain'])],
  [
    '@agent-foundry/composition',
    new Set([
      '@agent-foundry/contracts',
      '@agent-foundry/domain',
      '@agent-foundry/executors',
      '@agent-foundry/harness',
      '@agent-foundry/model-router',
      '@agent-foundry/orchestrator',
      '@agent-foundry/persistence',
    ]),
  ],
  [
    '@agent-foundry/api',
    new Set(['@agent-foundry/composition', '@agent-foundry/contracts', '@agent-foundry/domain']),
  ],
  ['@agent-foundry/worker', new Set(['@agent-foundry/composition'])],
  ['@agent-foundry/web', new Set(['@agent-foundry/contracts'])],
]);

export async function inspectArchitecture(rootDir, allowed = ALLOWED_INTERNAL_DEPENDENCIES) {
  const errors = [];
  const packages = await loadWorkspaces(rootDir);
  const byName = new Map(packages.map((item) => [item.manifest.name, item]));
  const graph = new Map();

  for (const workspace of packages) {
    const name = workspace.manifest.name;
    const allowedDeps = allowed.get(name);
    if (!allowedDeps) errors.push(`Workspace sem política arquitetural: ${name}`);
    const declared = new Set(
      [
        ...Object.keys(workspace.manifest.dependencies ?? {}),
        ...Object.keys(workspace.manifest.devDependencies ?? {}),
        ...Object.keys(workspace.manifest.peerDependencies ?? {}),
      ].filter((dep) => dep.startsWith('@agent-foundry/')),
    );
    graph.set(name, new Set());

    const files = await sourceFiles(workspace.dir);
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        if (!specifier.startsWith('@agent-foundry/')) continue;
        const [scope, packageName, ...deep] = specifier.split('/');
        const dependency = `${scope}/${packageName}`;
        graph.get(name).add(dependency);
        if (!byName.has(dependency))
          errors.push(`${relative(rootDir, file)} importa workspace inexistente ${dependency}`);
        if (dependency === name)
          errors.push(
            `${relative(rootDir, file)} importa o próprio pacote por alias: ${specifier}`,
          );
        if (deep.length)
          errors.push(`${relative(rootDir, file)} usa deep import proibido: ${specifier}`);
        if (!declared.has(dependency))
          errors.push(
            `${relative(rootDir, file)} importa ${dependency}, mas package.json não declara a dependência.`,
          );
        if (allowedDeps && !allowedDeps.has(dependency))
          errors.push(`${name} não pode depender de ${dependency}.`);
      }
    }

    for (const dependency of declared) {
      if (!allowedDeps?.has(dependency))
        errors.push(`${name} declara dependência arquitetural proibida: ${dependency}`);
    }
  }

  detectGraphCycles(graph, errors);
  return { ok: errors.length === 0, errors, graph, packages };
}

async function loadWorkspaces(rootDir) {
  const roots = ['apps', 'packages'];
  const output = [];
  for (const folder of roots) {
    const base = resolve(rootDir, folder);
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      output.push({ dir, manifest });
    }
  }
  return output;
}

async function sourceFiles(dir) {
  const result = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.next', 'coverage'].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (
        ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs'].includes(extname(entry.name)) &&
        !entry.name.endsWith('.d.ts')
      )
        result.push(path);
    }
  }
  await walk(dir);
  return result;
}

export function importSpecifiers(source) {
  const values = [];
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  return [...new Set(values)];
}

function detectGraphCycles(graph, errors) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(node) {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      errors.push(`Ciclo de packages: ${[...stack.slice(index), node].join(' -> ')}`);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph.get(node) ?? []) if (graph.has(dependency)) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
}
