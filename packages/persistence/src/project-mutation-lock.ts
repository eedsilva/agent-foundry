import type { ProjectMutationLock } from '@agent-foundry/domain';
import { safeSegment, withRecoverableDirectoryLock } from './fs-utils.js';

/** Cross-process lock for mutations whose invariant spans project stores. */
export class FileProjectMutationLock implements ProjectMutationLock {
  constructor(private readonly dataDir: string) {}

  runExclusive<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['projects', safeSegment(projectId), '.prd-approval.lock'],
      fn,
    );
  }
}
