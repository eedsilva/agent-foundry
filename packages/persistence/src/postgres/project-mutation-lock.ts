import type { ProjectMutationLock } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

/** Holds a PostgreSQL session lock across all stores used by the callback. */
export class PostgresProjectMutationLock implements ProjectMutationLock {
  constructor(private readonly sql: PostgresDb) {}

  async runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const reserved = await this.sql.reserve();
    const scope = `prd-approval:${projectId}`;
    try {
      await reserved`select pg_advisory_lock(hashtext(${scope}))`;
      try {
        return await fn();
      } finally {
        await reserved`select pg_advisory_unlock(hashtext(${scope}))`;
      }
    } finally {
      reserved.release();
    }
  }
}
