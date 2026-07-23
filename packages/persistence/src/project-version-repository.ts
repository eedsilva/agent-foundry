import { readdir, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { ProjectVersionSchema, type ProjectVersion } from '@agent-foundry/contracts';
import {
  ProjectVersionDiscardRefusedError,
  type ProjectVersionRepository,
} from '@agent-foundry/domain';
import { ensureDir, pathFor, safeSegment, withRecoverableDirectoryLock } from './fs-utils.js';
import { createVersioned, readVersioned, updateVersioned } from './run-repositories.js';

const IMMUTABLE_KEYS = Object.keys(ProjectVersionSchema.shape).filter(
  (key) => key !== 'protected' && key !== 'version',
) as Array<keyof ProjectVersion>;

export class FileProjectVersionRepository implements ProjectVersionRepository {
  constructor(private readonly dataDir: string) {}

  async create(version: ProjectVersion): Promise<void> {
    const parsed = ProjectVersionSchema.parse(version);
    await createVersioned(
      this.dataDir,
      [
        'projects',
        safeSegment(parsed.projectId),
        'versions',
        `${safeSegment(parsed.id)}.json.lock`,
      ],
      versionPath(this.dataDir, parsed.projectId, parsed.id),
      parsed,
      ProjectVersionSchema,
      'project-version',
    );
  }

  async discardUnpromoted(version: ProjectVersion): Promise<void> {
    const path = versionPath(this.dataDir, version.projectId, version.id);
    await withRecoverableDirectoryLock(
      this.dataDir,
      [
        'projects',
        safeSegment(version.projectId),
        'versions',
        `${safeSegment(version.id)}.json.lock`,
      ],
      async () => {
        const existing = await readVersioned(path, ProjectVersionSchema);
        if (!existing) return;
        if (
          existing.protected ||
          !isDeepStrictEqual(existing, ProjectVersionSchema.parse(version))
        ) {
          throw new ProjectVersionDiscardRefusedError(version.id);
        }
        await unlink(path);
      },
    );
  }

  async get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    return readVersioned(versionPath(this.dataDir, projectId, versionId), ProjectVersionSchema);
  }

  async update(version: ProjectVersion, expectedVersion: number): Promise<ProjectVersion> {
    return updateVersioned(
      this.dataDir,
      [
        'projects',
        safeSegment(version.projectId),
        'versions',
        `${safeSegment(version.id)}.json.lock`,
      ],
      versionPath(this.dataDir, version.projectId, version.id),
      version,
      expectedVersion,
      ProjectVersionSchema,
      'project-version',
      (existing, next) => {
        const changedImmutableKey = IMMUTABLE_KEYS.find(
          (key) => JSON.stringify(existing[key]) !== JSON.stringify(next[key]),
        );
        if (changedImmutableKey) {
          throw new Error(
            `Project version ${next.id} field '${changedImmutableKey}' is immutable and cannot be changed via update`,
          );
        }
      },
    );
  }

  async list(projectId: string, limit = 50): Promise<ProjectVersion[]> {
    const root = pathFor(this.dataDir, 'projects', projectId, 'versions');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const versions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => readVersioned(join(root, entry.name), ProjectVersionSchema)),
    );

    return versions
      .filter((version): version is ProjectVersion => version !== null)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, limit);
  }
}

function versionPath(dataDir: string, projectId: string, versionId: string): string {
  return pathFor(dataDir, 'projects', projectId, 'versions', `${versionId}.json`);
}
