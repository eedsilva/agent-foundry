// The generated API has no browser-origin or cookie-auth surface. Keep logging
// fail-closed until a redacted structured logger is part of the scaffold.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const apiRoot = join(root, 'apps', 'api', 'src');
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);
const CORS_HEADER = /access-control-allow-origin/i;
const COOKIE_AUTH = /cookie/i;
// ponytail: balanced parentheses are unnecessary for this canary; use an AST
// scanner if the scaffold grows indirect logging patterns.
const CONSOLE_CALL = /\bconsole\.(?:debug|error|info|log|trace|warn)\s*\(([^)]*)\)/gi;
const SENSITIVE_LOG_VALUE =
  /(?:access.?token|authorization|cookie|email|err(?:or)?|key|password|request|secret|token)|process\.env/i;
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
    if (CORS_HEADER.test(line)) offenders.push(`${location} — CORS response header`);
    if (COOKIE_AUTH.test(line)) offenders.push(`${location} — cookie-auth reference`);
  });
  for (const match of source.matchAll(CONSOLE_CALL)) {
    if (SENSITIVE_LOG_VALUE.test(match[1])) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      offenders.push(`${path}:${line} — sensitive value in console output`);
    }
  }
}

if (offenders.length > 0) {
  console.error('Generated API boundary check failed:');
  for (const offender of offenders) console.error(`  - ${offender}`);
  console.error(
    '\nThe generated API must not emit Access-Control-Allow-Origin, authenticate from cookies,\n' +
      'or log tokens, keys, credentials, request data, or raw errors. Add a redacted\n' +
      'structured logger before permitting API logging.',
  );
  process.exit(1);
}

console.log('check-api-boundaries: ok — no CORS, cookie auth, or sensitive API logging');
