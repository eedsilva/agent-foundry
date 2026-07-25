import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';
import { createPostgresClient } from './client.js';
import { migrateUp } from './migrator.js';

// Duplicated from testing.ts: importing testing.ts here would pull vitest's
// test-context APIs into the globalSetup context, where they crash.
function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    sharedPgUri?: string;
  }
}

// Boots ONE Postgres container for the whole vitest run instead of one per
// suite. Only active with SHARED_PG=1 (the test:unit:slow script); suites fall
// back to their own container otherwise, so single-file runs keep working.
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (process.env.SHARED_PG !== '1' || !probeDocker()) return;
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const uri = container.getConnectionUri();
  const sql = createPostgresClient(uri);
  await migrateUp(sql);
  await sql.end({ timeout: 5 });
  project.provide('sharedPgUri', uri);
  return async () => {
    await container.stop();
  };
}
