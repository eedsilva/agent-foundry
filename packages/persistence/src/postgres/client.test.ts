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

  it('disables prepared statements for transaction poolers, which cannot serve them', async () => {
    await expect(
      preparedStatements('postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres'),
    ).resolves.toBe(false);
    await expect(
      preparedStatements('postgres://u:p@pgbouncer.internal:5432/foundry?pgbouncer=true'),
    ).resolves.toBe(false);
  });

  it('does not depend on the operator spelling the option in the URL', async () => {
    // Both of these fail open in postgres.js: `no_prepare` is not read as a
    // query param at all, and `prepare=0` resolves to the truthy string '0'.
    await expect(
      preparedStatements(
        'postgres://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres?no_prepare=true',
      ),
    ).resolves.toBe(false);
    await expect(
      preparedStatements('postgres://u:p@db.example.com:5432/foundry?prepare=0'),
    ).resolves.toBe('0');
  });
});
