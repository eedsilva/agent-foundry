#!/usr/bin/env node
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';

const root = resolve(import.meta.dirname, '..');
loadDotEnv({ path: resolve(root, '.env'), quiet: true });

// @agent-foundry/persistence resolves through its package.json "exports" map, which points the
// `import` condition at dist/index.js (tsup output) rather than src. A plain `node` script (no
// tsx/ts-node loader) can only see that built artifact, so give a clear next step instead of
// Node's raw "module not found" when nobody has run `npm run build` yet.
let persistence;
try {
  persistence = await import('@agent-foundry/persistence');
} catch (error) {
  console.error('Could not load @agent-foundry/persistence. Run `npm run build` first.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const { createPostgresClient, migrateUp } = persistence;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = createPostgresClient(url);
const applied = await migrateUp(sql);
console.log(
  applied.length === 0 ? 'schema up to date' : `applied migrations: ${applied.join(', ')}`,
);
await sql.end({ timeout: 5 });
