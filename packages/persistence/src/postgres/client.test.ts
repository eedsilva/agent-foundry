import { describe, expect, it } from 'vitest';
import { createPostgresClient } from './client.js';

/**
 * postgres.js resolves its options without connecting, so these assertions
 * read the resolved client rather than talking to a server (#692).
 */
async function preparedStatements(url: string): Promise<unknown> {
  const sql = createPostgresClient(url);
  try {
    return sql.options.prepare;
  } finally {
    await sql.end({ timeout: 0 });
  }
}

describe('createPostgresClient', () => {
  it('keeps prepared statements for direct Postgres', async () => {
    await expect(preparedStatements('postgres://u:p@db.example.com:5432/foundry')).resolves.toBe(
      true,
    );
  });

  it('disables prepared statements for the transaction pooler, which cannot serve them', async () => {
    await expect(
      preparedStatements('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres'),
    ).resolves.toBe(false);
  });

  it('does not key off a flag postgres.js would forward as a startup parameter', async () => {
    // `?pgbouncer=true` is a Prisma convention, not a postgres.js option: the
    // driver copies unknown query params into the startup packet, where the
    // server rejects them. Detection stays on the port, and this URL keeps
    // whatever postgres.js decides on its own.
    await expect(
      preparedStatements('postgres://u:p@pgbouncer.internal:5432/foundry?pgbouncer=true'),
    ).resolves.toBe(true);
  });

  it('pins the fail-open spelling an operator would reach for', async () => {
    // `prepare=0` resolves to the truthy string '0' and silently keeps
    // prepared statements on; only the literal `prepare=false` works.
    await expect(
      preparedStatements('postgres://u:p@db.example.com:5432/foundry?prepare=0'),
    ).resolves.toBe('0');
    await expect(
      preparedStatements('postgres://u:p@db.example.com:5432/foundry?prepare=false'),
    ).resolves.toBe(false);
  });
});
