// Fails the build when SUPABASE_SERVICE_ROLE_KEY is referenced anywhere a
// browser request is served. The service-role key bypasses row level security
// entirely, so one forgotten check in a request-path handler becomes a silent
// cross-tenant read (ADR 0038). Request handlers build their client from the
// anon key plus the caller's token instead (apps/api/src/supabase.ts) — the
// Generated applications have no service-role runtime path. Operational
// scripts outside `apps/` may use the key for local database setup/checks.
//
// This is a textual check, not a semantic one: it catches the honest mistake
// (reading the env var on the request path), which is the failure mode
// model-written handlers actually have.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NEEDLE = 'SUPABASE_SERVICE_ROLE_KEY';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist']);

const offenders = [];
walk(join(root, 'apps'));

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      continue;
    }
    const posixPath = relative(root, path).split(sep).join('/');
    if (readFileSync(path, 'utf8').includes(NEEDLE)) {
      offenders.push(posixPath);
    }
  }
}

if (offenders.length > 0) {
  console.error(`${NEEDLE} is referenced on the request path:`);
  for (const offender of offenders) console.error(`  - ${offender}`);
  console.error(
    `\nThe service-role key bypasses row level security. Request handlers must use\n` +
      `createRequestClient (apps/api/src/supabase.ts), which forwards the caller's\n` +
      `token so RLS evaluates as that user. The generated runtime has no\n` +
      `service-role path; operational scripts live outside apps/.`,
  );
  process.exit(1);
}
console.log(`check-service-role: ok — no request-path reference to ${NEEDLE}`);
