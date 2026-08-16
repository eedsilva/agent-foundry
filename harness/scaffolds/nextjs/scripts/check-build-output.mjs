// `pnpm --recursive build` exits 0 for a workspace package it silently skipped,
// so a build that produced nothing reports the same success as one that
// produced everything. Assert the artifact each package claiming a `build`
// script owes, and print it, so the verification log carries evidence the
// build actually ran rather than just its exit code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist', '.git']);
const failures = [];
const artifacts = [];

// Every package but the root, found rather than assumed: `pnpm-workspace.yaml`
// starts at `apps/*` and a generated app is free to add `packages/*`, which a
// hard-coded `apps/` would stop covering — silently, which is the one failure
// mode this script exists to remove.
for (const pkg of packageDirectories(root)) {
  const name = relative(root, pkg).split(sep).join('/');
  // Unreadable is not the same as "declares no build": skipping it here would
  // be the silent skip this script exists to catch.
  const manifest = readJson(join(pkg, 'package.json'));
  if (!manifest) {
    failures.push(`${name}/package.json could not be read`);
    continue;
  }
  if (!manifest.scripts?.build) continue;

  if (dependsOnNext(manifest)) {
    const buildIdPath = join(pkg, '.next/BUILD_ID');
    const buildId = existsSync(buildIdPath) ? readFileSync(buildIdPath, 'utf8').trim() : '';
    if (buildId === '') {
      failures.push(`${name}/.next/BUILD_ID is empty or missing`);
      continue;
    }
    artifacts.push(`${name}/.next/BUILD_ID = ${buildId}`);
    continue;
  }

  const outDir = readJson(join(pkg, 'tsconfig.json'))?.compilerOptions?.outDir ?? 'dist';
  const contents = existsSync(join(pkg, outDir)) ? readdirSync(join(pkg, outDir)) : [];
  if (contents.length === 0) {
    failures.push(`${name}/${outDir} is empty or missing`);
    continue;
  }
  artifacts.push(`${name}/${outDir} = ${contents.length} entries`);
}

function* packageDirectories(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = join(directory, entry.name);
    if (existsSync(join(child, 'package.json'))) yield child;
    else yield* packageDirectories(child);
  }
}

// ponytail: JSON.parse, so a tsconfig with comments falls back to the default
// outDir instead of being read. Reach for a jsonc parser only if a generated
// app starts writing one.
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function dependsOnNext(manifest) {
  return Boolean(manifest.dependencies?.next ?? manifest.devDependencies?.next);
}

if (failures.length > 0) {
  console.error('The recursive build declared success without producing every artifact:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nA package that declares a build script must produce its output. An empty or\n' +
      'missing artifact means the package was skipped or its build died before\n' +
      'writing — rerun the build for that package alone and read its output.',
  );
  process.exit(1);
}

for (const artifact of artifacts) console.log(`check-build-output: ${artifact}`);
console.log('check-build-output: ok');
