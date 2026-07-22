import { basename, extname } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const graph = JSON.parse(await readFile('graphify-out/graph.json', 'utf8'));
const nodesByCommunity = new Map();

for (const node of graph.nodes ?? []) {
  if (node.community == null) continue;
  const nodes = nodesByCommunity.get(node.community) ?? { files: [], labels: [] };
  if (node.source_file) nodes.files.push(node.source_file);
  if (node.label) nodes.labels.push(node.label);
  nodesByCommunity.set(node.community, nodes);
}

const words = (value) =>
  value
    .replace(extname(value), '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const labels = {};
for (const [community, { files, labels: nodeLabels }] of nodesByCommunity) {
  const [file] =
    Object.entries(
      files.reduce((counts, path) => {
        counts[path] = (counts[path] ?? 0) + 1;
        return counts;
      }, {}),
    ).sort(([, left], [, right]) => right - left)[0] ?? [];
  if (file) {
    const parts = file.split('/');
    const scope = parts[0] === 'packages' || parts[0] === 'apps' ? parts[1] : parts[0];
    labels[community] = [...words(scope), ...words(basename(file))].slice(0, 5).join(' ');
  } else {
    labels[community] = words(nodeLabels[0] ?? `community ${community}`)
      .slice(0, 5)
      .join(' ');
  }
}

await writeFile('graphify-out/.graphify_labels.json', `${JSON.stringify(labels, null, 2)}\n`);

const reportPath = 'graphify-out/GRAPH_REPORT.md';
let report = await readFile(reportPath, 'utf8');
for (const [community, label] of Object.entries(labels)) {
  report = report
    .replaceAll(`|Community ${community}]]`, `|${label}]]`)
    .replaceAll(
      `Community ${community} - "Community ${community}"`,
      `Community ${community} - "${label}"`,
    );
}
await writeFile(reportPath, report);
