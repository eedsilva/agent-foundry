// The generated API has no browser-origin or cookie-auth surface. Keep logging
// fail-closed until a redacted structured logger is part of the scaffold.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiRoot = join(root, 'apps', 'api', 'src');
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);
const CORS_REFERENCE = /access-control-allow-origin|['"]hono\/cors['"]|\bcors\s*\(/i;
const COOKIE_AUTH = /cookie/i;
// No redacted structured logger exists in the scaffold, so reject every logging
// method call regardless of receiver or argument names.
const LOG_CALL =
  /(?:\.(?:debug|error|info|log|trace|warn)|\[\s*['"](?:debug|error|info|log|trace|warn)['"]\s*\])\s*(?:\?\.)?\s*\(/gi;
const LOG_DESTRUCTURE =
  /\b(?:const|let|var)\s*\{[^}]*\b(?:debug|error|info|log|trace|warn)\b[^}]*\}\s*=\s*console\b/gi;
const offenders = [];

if (existsSync(apiRoot)) walk(apiRoot);

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      continue;
    }
    check(relative(root, path).split(sep).join('/'), readFileSync(path, 'utf8'));
  }
}

function check(path, source) {
  source.split(/\r?\n/).forEach((line, index) => {
    const location = `${path}:${index + 1}`;
    if (CORS_REFERENCE.test(line)) offenders.push(`${location} — CORS configuration`);
    if (COOKIE_AUTH.test(line)) offenders.push(`${location} — cookie-auth reference`);
  });
  for (const match of source.matchAll(LOG_CALL)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    offenders.push(`${path}:${line} — API logging is not permitted`);
  }
  for (const match of source.matchAll(LOG_DESTRUCTURE)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    offenders.push(`${path}:${line} — API logging is not permitted`);
  }
}

if (offenders.length > 0) {
  console.error('Generated API boundary check failed:');
  for (const offender of offenders) console.error(`  - ${offender}`);
  console.error(
    '\nThe generated API must not configure CORS, authenticate from cookies, or log through\n' +
      'an unredacted logger. Add a redacted structured logger before permitting API logging.',
  );
  process.exit(1);
}

console.log('check-api-boundaries: ok — no CORS, cookie auth, or API logging');
