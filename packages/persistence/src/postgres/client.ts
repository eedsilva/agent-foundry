import postgres, { type Sql } from 'postgres';

export type PostgresDb = Sql;

export function createPostgresClient(url: string): PostgresDb {
  // ponytail: fixed small pool; tune via env only when a real workload demands it.
  return postgres(url, { max: 10, onnotice: () => {} });
}
