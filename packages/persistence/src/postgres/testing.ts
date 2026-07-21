import { execSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe } from 'vitest';
import { createPostgresClient, type PostgresDb } from './client.js';
import { migrateUp } from './migrator.js';

export function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = probeDocker();
if (process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for Postgres tests; refusing to skip.');
}

export function describePostgres(name: string, fn: (ctx: { db: () => PostgresDb }) => void): void {
  const suite = dockerAvailable ? describe : describe.skip;
  suite(name, () => {
    let sql: PostgresDb | undefined;
    let stop: (() => Promise<unknown>) | undefined;

    beforeAll(async () => {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('postgres:17-alpine').start();
      stop = () => container.stop();
      sql = createPostgresClient(container.getConnectionUri());
      await migrateUp(sql);
    }, 120_000);

    afterEach(async () => {
      if (!sql) return;
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'schema_migrations'`;
      if (tables.length > 0) {
        await sql.unsafe(
          `truncate table ${tables.map((t) => `"${t.table_name}"`).join(', ')} cascade`,
        );
      }
    });

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await stop?.();
    }, 60_000);

    fn({
      db: () => {
        if (!sql) throw new Error('postgres container not started');
        return sql;
      },
    });
  });
}
