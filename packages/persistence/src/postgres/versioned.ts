import type { ISql } from 'postgres';
import { NotFoundError, VersionConflictError } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: unknown }).code === '23505'
  );
}

/** Serializes the 11 verbatim `pg_advisory_xact_lock` call sites (conversation-repository.ts,
 * artifact-store.ts, step-event-repository.ts). Must run inside `sql.begin` -- the lock is
 * transaction-scoped and auto-releases on commit/rollback. Unrelated to migrator.ts's
 * session-scoped pg_advisory_lock, which pins a reserved connection instead. */
export async function acquireScopeLock(tx: ISql, scope: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtext(${scope}))`;
}

/**
 * Wraps a value for insertion into a jsonb column. `ISql.json()` expects its own
 * `JSONValue` type, but Zod's inferred output types (Operation, Message, ...) aren't
 * structurally assignable to it even though the runtime value is always
 * JSON-serializable -- this cast documents that mismatch once instead of at every
 * `.json(x as any)` call site across the postgres adapters.
 */
export function toJsonb(sql: ISql, value: unknown) {
  return sql.json(value as never);
}

/** Insert a new versioned row. Mirrors `createVersioned` in ../run-repositories.ts. */
export async function insertVersioned(
  sql: PostgresDb,
  opts: {
    table: string;
    entity: string;
    id: string;
    version: number;
    columns: Record<string, unknown>;
    data: unknown;
  },
): Promise<void> {
  if (opts.version !== 1) {
    throw new Error(`New ${opts.entity} ${opts.id} must start at version 1`);
  }
  const row = {
    id: opts.id,
    ...opts.columns,
    version: opts.version,
    data: toJsonb(sql, opts.data),
  };
  try {
    await sql`insert into ${sql(opts.table)} ${sql(row)}`;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(`${opts.entity} ${opts.id} already exists`);
    }
    throw error;
  }
}

/**
 * Compare-and-swap update: `UPDATE ... WHERE <keyColumns> AND version = expectedVersion`.
 * Zero rows affected means either the row is missing (NotFoundError) or another writer
 * already bumped the version (VersionConflictError) -- distinguish with a follow-up read.
 */
export async function updateVersioned(
  sql: PostgresDb,
  opts: {
    table: string;
    entity: string;
    id: string;
    keyColumns: Record<string, string>;
    expectedVersion: number;
    nextData: unknown;
    columns: Record<string, unknown>;
  },
): Promise<void> {
  const keys = Object.entries(opts.keyColumns);
  // sql(obj) only builds AND-joined conditions for "in"/"values"/"update"/"insert" contexts,
  // not "where" -- so the key/value pairs are AND-joined by hand as nested fragments instead.
  const where = keys
    .map(([col, value]) => sql`${sql(col)} = ${value}`)
    .reduce((acc, clause) => sql`${acc} and ${clause}`);
  const setRow = { data: toJsonb(sql, opts.nextData), ...opts.columns };

  const result = await sql`
    update ${sql(opts.table)}
       set version = version + 1, ${sql(setRow)}
     where ${where}
       and version = ${opts.expectedVersion}`;
  if (result.count === 1) return;

  const existing = await sql<{ version: number }[]>`
    select version from ${sql(opts.table)} where ${where}`;
  const row = existing[0];
  if (!row) throw new NotFoundError(`${opts.entity} ${opts.id} not found`);
  throw new VersionConflictError(opts.entity, opts.id, opts.expectedVersion, row.version);
}
