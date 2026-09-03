import type { ProjectMutationLock } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { acquireScopeLock } from './versioned.js';

export function prdApprovalScope(projectId: string): string {
  return `prd-approval:${projectId}`;
}

/**
 * Holds a transaction-scoped advisory lock across all stores used by the
 * callback. Transaction-scoped, not session-scoped: `sql.reserve()` pins the
 * client→pooler socket, not the backend behind a transaction-mode pooler, so a
 * session lock could unlock on a different backend — losing exclusion and
 * leaking the lock. `docs/OPERATIONS.md` promises pooler-safe runtime adapters
 * on 6543; a transaction lock keeps that promise and is released by the
 * commit/rollback.
 */
export class PostgresProjectMutationLock implements ProjectMutationLock {
  constructor(private readonly sql: PostgresDb) {}

  runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await acquireScopeLock(tx, prdApprovalScope(projectId));
      return fn();
    }) as Promise<T>;
  }
}
