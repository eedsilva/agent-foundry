import { NotFoundError, VersionConflictError } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as { code?: unknown }).code === '23505'
  );
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
  const columnNames = ['id', ...Object.keys(opts.columns), 'version', 'data'];
  const values: unknown[] = [
    opts.id,
    ...Object.values(opts.columns),
    opts.version,
    sql.json(opts.data as any),
  ];
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  try {
    await sql.unsafe(
      `insert into ${opts.table} (${columnNames.join(', ')}) values (${placeholders})`,
      values as any[],
    );
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
  const columns = Object.entries(opts.columns);
  const whereClause = keys.map(([col], i) => `${col} = $${i + 1}`).join(' and ');
  const dataParam = keys.length + 1;
  const columnAssignments = columns
    .map(([col], i) => `${col} = $${keys.length + 2 + i}`)
    .join(', ');
  const expectedVersionParam = keys.length + 2 + columns.length;

  const result = await sql.unsafe(
    `update ${opts.table}
       set version = version + 1,
           data = $${dataParam}${columnAssignments ? `, ${columnAssignments}` : ''}
     where ${whereClause}
       and version = $${expectedVersionParam}`,
    [
      ...keys.map(([, value]) => value),
      sql.json(opts.nextData as any),
      ...columns.map(([, value]) => value),
      opts.expectedVersion,
    ] as any[],
  );
  if (result.count === 1) return;

  const existing = await sql.unsafe<{ version: number }[]>(
    `select version from ${opts.table} where ${whereClause}`,
    keys.map(([, value]) => value) as any[],
  );
  const row = existing[0];
  if (!row) throw new NotFoundError(`${opts.entity} ${opts.id} not found`);
  throw new VersionConflictError(opts.entity, opts.id, opts.expectedVersion, row.version);
}
