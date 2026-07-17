import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectVersionSchema, type ProjectVersion } from '@agent-foundry/contracts';
import type { ProjectVersionRepository } from '@agent-foundry/domain';
import { VersionConflictError } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJson,
  readJsonOrNull,
  safeSegment,
  withDirectoryLock,
} from './fs-utils.js';

const IMMUTABLE_KEYS = Object.keys(ProjectVersionSchema.shape).filter(
  (key) => key !== 'protected' && key !== 'version',
) as Array<keyof ProjectVersion>;

export class FileProjectVersionRepository implements ProjectVersionRepository {
  constructor(private readonly dataDir: string) {}

  async create(version: ProjectVersion): Promise<void> {
    const parsed = ProjectVersionSchema.parse(version);
    if (parsed.version !== 1) {
      throw new Error(`New project version ${parsed.id} must start at version 1`);
    }
    const path = this.pathFor(parsed.projectId, parsed.id);
    await withDirectoryLock(`${path}.lock`, async () => {
      const existing = await readJsonOrNull<unknown>(path);
      if (existing) throw new Error(`Project version ${parsed.id} already exists`);
      await atomicWriteJson(path, parsed);
    });
  }

  async get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    const value = await readJsonOrNull<unknown>(this.pathFor(projectId, versionId));
    return value ? ProjectVersionSchema.parse(value) : null;
  }

  async update(version: ProjectVersion, expectedVersion: number): Promise<ProjectVersion> {
    if (version.version !== expectedVersion) {
      throw new VersionConflictError(
        'project-version',
        version.id,
        expectedVersion,
        version.version,
      );
    }
    const path = this.pathFor(version.projectId, version.id);
    return withDirectoryLock(`${path}.lock`, async () => {
      const existing = await this.get(version.projectId, version.id);
      if (!existing) throw new Error(`Project version ${version.id} does not exist`);
      if (existing.version !== expectedVersion) {
        throw new VersionConflictError(
          'project-version',
          version.id,
          expectedVersion,
          existing.version,
        );
      }
      const changedImmutableKey = IMMUTABLE_KEYS.find(
        (key) => JSON.stringify(existing[key]) !== JSON.stringify(version[key]),
      );
      if (changedImmutableKey) {
        throw new Error(
          `Project version ${version.id} field '${changedImmutableKey}' is immutable and cannot be changed via update`,
        );
      }
      const updated = ProjectVersionSchema.parse({ ...version, version: expectedVersion + 1 });
      await atomicWriteJson(path, updated);
      return updated;
    });
  }

  async list(projectId: string, limit = 50): Promise<ProjectVersion[]> {
    const root = join(this.dataDir, 'projects', safeSegment(projectId), 'versions');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const versions = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => ProjectVersionSchema.parse(await readJson(join(root, entry.name)))),
    );

    return versions.sort((left, right) => right.sequence - left.sequence).slice(0, limit);
  }

  private pathFor(projectId: string, versionId: string): string {
    return join(
      this.dataDir,
      'projects',
      safeSegment(projectId),
      'versions',
      `${safeSegment(versionId)}.json`,
    );
  }
}
