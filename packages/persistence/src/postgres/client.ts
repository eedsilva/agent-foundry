import postgres, { type Sql } from 'postgres';

export type PostgresDb = Sql;

/**
 * Transaction poolers (Supabase's Supavisor on 6543, PgBouncer in transaction
 * mode) cannot serve named prepared statements, which postgres.js sends by
 * default. The runtime's critical sections now run inside `sql.begin`, where
 * the driver's re-parse recovery does not help — the rejected statement aborts
 * the transaction first. So the documented target turns them off here instead
 * of relying on an operator to spell an option correctly in the URL: only the
 * literal `?prepare=false` works there (`?prepare=0` resolves to the string
 * `'0'`, which is truthy, and `?no_prepare=true` is not read at all), and both
 * mistakes fail open. Direct Postgres keeps prepared statements. A pooler on
 * another port uses `?prepare=false`, which postgres.js consumes; no invented
 * flag here, since any query param it does not know is forwarded in the
 * startup packet and the server rejects unknown parameters. See #692.
 */
function isTransactionPooler(url: string): boolean {
  try {
    return new URL(url).port === '6543';
  } catch {
    return false;
  }
}

export function createPostgresClient(url: string): PostgresDb {
  // ponytail: fixed small pool; tune via env only when a real workload demands it.
  return postgres(url, {
    max: 10,
    ...(isTransactionPooler(url) ? { prepare: false } : {}),
    onnotice: () => {},
  });
}
