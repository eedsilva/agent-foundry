import type { PreviewLifecycleLock } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { acquireScopeLock } from './versioned.js';

export function projectLifecycleScope(projectId: string): string {
  return `project-lifecycle:${projectId}`;
}

export class PostgresPreviewLifecycleLock implements PreviewLifecycleLock {
  constructor(private readonly sql: PostgresDb) {}

  async withSessionLock<T>(
    sessionId: string,
    operation: () => Promise<T>,
    projectId?: string,
  ): Promise<T> {
    return this.sql.begin(async (tx) => {
      if (projectId) await acquireScopeLock(tx, projectLifecycleScope(projectId));
      await acquireScopeLock(tx, `preview:${sessionId}`);
      return operation();
    }) as Promise<T>;
  }

  async withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      await acquireScopeLock(tx, projectLifecycleScope(projectId));
      return operation();
    }) as Promise<T>;
  }
}
