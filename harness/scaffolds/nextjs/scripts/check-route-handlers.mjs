// Next rejects a route module with a default export or with no HTTP method at
// all, but only while building the route — so the defect survives every task
// commit and surfaces once, late, at the final build. Catch it per task.
//
// The allowlist is stricter than Next, which structurally tolerates an excess
// export: a value exported from a framework-loaded module is dead code that
// reads as working configuration — the Pages Router `export const config`
// habit a model brings to an App Router file. Same stance
// check-server-actions.mjs already takes for "use server" modules.
//
// ponytail: line-wise regex, not a parser — misses a multi-line `export {`
// list and an export written inside a template literal. Swap in the TypeScript
// compiler's scanner if a generated app ever writes exports that way.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ROUTE_FILE = /^route\.(?:ts|tsx|js|jsx|mjs)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']);
const ALLOWED = new Set([
  ...METHODS,
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'generateStaticParams',
]);
const TYPE_EXPORT = /^\s*export\s+(?:type|interface)\b/;
/** Named for the framework's benefit by neither: `default`, and a re-export that can hide one. */
const OPAQUE_EXPORT = /^\s*export\s+(default\b|\*)/;
const DECLARATION_EXPORT =
  /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/;
const LIST_EXPORT = /^\s*export\s+\{([^}]*)\}/;
const offenders = [];

// A workspace with no apps yet has no route handlers to reject; crashing on
// the missing directory would fail the task gate for the wrong reason.
if (existsSync(join(root, 'apps'))) walk(join(root, 'apps'));

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      continue;
    }
    if (!ROUTE_FILE.test(entry.name)) continue;

    // Only App Router files are route modules; apps/api is free to name a file route.ts.
    const posixPath = relative(root, path).split(sep).join('/');
    if (!posixPath.includes('/app/')) continue;
    check(posixPath, readFileSync(path, 'utf8'));
  }
}

function check(posixPath, source) {
  let methods = 0;
  source.split(/\r?\n/).forEach((line, index) => {
    const at = `${posixPath}:${index + 1}`;
    if (TYPE_EXPORT.test(line)) return;
    const opaque = OPAQUE_EXPORT.exec(line);
    if (opaque) {
      offenders.push(`${at} — export ${opaque[1]}`);
      return;
    }
    const declaration = DECLARATION_EXPORT.exec(line);
    const names = declaration ? [declaration[1]] : exportedNames(LIST_EXPORT.exec(line)?.[1]);
    for (const name of names) {
      if (METHODS.has(name)) methods += 1;
      if (!ALLOWED.has(name)) offenders.push(`${at} — export '${name}'`);
    }
  });
  if (methods === 0) offenders.push(`${posixPath} — no HTTP method exported`);
}

function exportedNames(list) {
  if (!list) return [];
  return list
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith('type '))
    .map((entry) => entry.split(/\s+as\s+/).pop());
}

if (offenders.length > 0) {
  console.error('Next route handlers may only export HTTP methods and route segment config:');
  for (const offender of offenders) console.error(`  - ${offender}`);
  const config = [...ALLOWED].filter((name) => !METHODS.has(name));
  console.error(
    `\nA route module is loaded by the framework, not imported: export a named async\n` +
      `function per HTTP method (${[...METHODS].join(', ')}) and,\n` +
      `optionally, the route segment config (${config.join(', ')}).\n` +
      `Types are erased and stay allowed; move every other value to a sibling\n` +
      `module and import it.`,
  );
  process.exit(1);
}

console.log('check-route-handlers: ok');
