// The generated API has one HTTP runtime. A model reintroducing the legacy
// adapter must fail the scaffold build instead of silently shipping two stacks.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NEEDLE = /\bfastify\b/i;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);
const offenders = [];

if (existsSync(join(root, 'apps'))) walk(join(root, 'apps'));

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      continue;
    }
    if (NEEDLE.test(readFileSync(path, 'utf8'))) {
      offenders.push(relative(root, path).split(sep).join('/'));
    }
  }
}

if (offenders.length > 0) {
  console.error('The generated HTTP scaffold must not reference Fastify:');
  for (const offender of offenders) console.error(`  - ${offender}`);
  process.exit(1);
}

console.log('check-http-framework: ok — no legacy HTTP adapter reference');
