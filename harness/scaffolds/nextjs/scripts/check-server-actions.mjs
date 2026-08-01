// Next's production build can accept an invalid server-action export and the
// dev runtime only reports it when the route imports the module. Catch that
// boundary before a generated task reaches browser verification.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);
const USE_SERVER = /^\s*["']use server["']\s*;?\s*$/m;
const INVALID_EXPORT = /^\s*export\s+(?:(?:const|let|var|class|function)\b|default\b|\{|\*)/;
const offenders = [];

walk(join(root, 'apps'));

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extension(entry.name))) continue;

    const source = readFileSync(path, 'utf8');
    if (!USE_SERVER.test(source)) continue;
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (INVALID_EXPORT.test(line)) {
        offenders.push(
          `${relative(root, path).split(sep).join('/')} :${index + 1}`.replace(' :', ':'),
        );
      }
    });
  }
}

function extension(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

if (offenders.length > 0) {
  console.error('Next use-server modules may only export async functions:');
  for (const offender of offenders) console.error(`  - ${offender}`);
  console.error(
    '\nMove shared state and type exports to a separate module; keep only async server actions in files with the use-server directive.',
  );
  process.exit(1);
}

console.log('check-server-actions: ok');
