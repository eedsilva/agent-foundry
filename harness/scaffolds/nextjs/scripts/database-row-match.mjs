import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function loadWorkspaceEnv() {
  for (const path of [join(process.cwd(), '.env'), join(process.cwd(), '..', '.env')]) {
    try {
      const content = await readFile(path, 'utf8');
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;
        const value = match[2].replace(/^['"]|['"]$/g, '');
        process.env[match[1]] = value;
      }
      if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return;
    } catch {
      // Try the sibling project root before reporting missing credentials.
    }
  }
  // The explicit missing-credentials error below is safer than exposing the
  // workspace path or any partial environment contents.
}

await loadWorkspaceEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const expectedTitleSha256 = process.env.AGENT_FOUNDRY_VALIDATION_ROW_TITLE_SHA256;
const runStartedAt = process.env.AGENT_FOUNDRY_VALIDATION_RUN_STARTED_AT;
if (!url || !serviceRoleKey) {
  throw new Error('database-row-match: .env is missing the Supabase URL or service-role key.');
}
if (!expectedTitleSha256) {
  throw new Error('database-row-match: no browser-created row expectation was provided.');
}
if (!runStartedAt || Number.isNaN(Date.parse(runStartedAt))) {
  throw new Error('database-row-match: no validation run start time was provided.');
}

const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` };

// The generated app owns its table names (todos, appointments, ...), so the
// check cannot hard-code one. PostgREST's OpenAPI root lists every exposed
// table; any table with a created_at column is a candidate, and the match is
// any string column whose sha256 equals the browser-typed value's hash.
const specResponse = await fetch(`${url}/rest/v1/`, { headers });
if (!specResponse.ok) {
  throw new Error(`database-row-match: schema discovery failed with HTTP ${specResponse.status}.`);
}
const spec = await specResponse.json();
const tables = Object.entries(spec.definitions ?? {})
  .filter(([, definition]) => definition?.properties?.created_at)
  .map(([name]) => name);
if (tables.length === 0) {
  throw new Error('database-row-match: no exposed table has a created_at column.');
}

const matches = [];
for (const table of tables) {
  const response = await fetch(
    `${url}/rest/v1/${table}?select=*&order=created_at.desc&limit=1000`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`database-row-match: ${table} query failed with HTTP ${response.status}.`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) continue;
  for (const row of rows) {
    if (Date.parse(String(row.created_at)) < Date.parse(runStartedAt)) continue;
    const matched = Object.entries(row).some(
      ([column, value]) =>
        column !== 'id' &&
        typeof value === 'string' &&
        createHash('sha256').update(value).digest('hex') === expectedTitleSha256,
    );
    if (matched) matches.push({ table, row });
  }
}
if (matches.length !== 1) {
  throw new Error(
    'database-row-match: exactly one row created during this validation run must match the browser value.',
  );
}
const [{ table: matchedTable, row: matched }] = matches;

const rowFingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      table: matchedTable,
      id: matched.id,
      titleSha256: expectedTitleSha256,
      createdAt: matched.created_at,
    }),
  )
  .digest('hex');
console.log('database-row-match: browser-created value matched a persisted row');
console.log(`AGENT_FOUNDRY_DB_MATCH:${rowFingerprint}`);
