// `pnpm --recursive build` exits 0 for a workspace package it silently skipped,
// so a build that produced nothing reports the same success as one that
// produced everything. Assert the artifact each package claiming a `build`
// script owes, and print it, so the verification log carries evidence the
// build actually ran rather than just its exit code.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apps = join(root, 'apps');
const failures = [];
const artifacts = [];

for (const entry of readdirSync(apps, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const app = join(apps, entry.name);
  const manifest = readJson(join(app, 'package.json'));
  if (!manifest?.scripts?.build) continue;

  if (dependsOnNext(manifest)) {
    const buildIdPath = join(app, '.next/BUILD_ID');
    const buildId = existsSync(buildIdPath) ? readFileSync(buildIdPath, 'utf8').trim() : '';
    if (buildId === '') {
      failures.push(`apps/${entry.name}/.next/BUILD_ID is empty or missing`);
      continue;
    }
    artifacts.push(`apps/${entry.name}/.next/BUILD_ID = ${buildId}`);
    continue;
  }

  const outDir = readJson(join(app, 'tsconfig.json'))?.compilerOptions?.outDir ?? 'dist';
  const contents = existsSync(join(app, outDir)) ? readdirSync(join(app, outDir)) : [];
  if (contents.length === 0) {
    failures.push(`apps/${entry.name}/${outDir} is empty or missing`);
    continue;
  }
  artifacts.push(`apps/${entry.name}/${outDir} = ${contents.length} entries`);
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
