import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, type Project } from '@agent-foundry/contracts';
import type { ProjectRepository } from '@agent-foundry/domain';
import { VersionConflictError } from '@agent-foundry/domain';
import {
  atomicWriteJson,
  ensureDir,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

export class FileProjectRepository implements ProjectRepository {
  constructor(private readonly dataDir: string) {}

  async create(project: Project): Promise<void> {
    const parsed = ProjectSchema.parse(project);
    const path = this.pathFor(parsed.id);
    if (parsed.version !== 1) throw new Error(`New project ${parsed.id} must start at version 1`);
    await withRecoverableDirectoryLock(
      this.dataDir,
      ['projects', safeSegment(parsed.id), 'project.json.lock'],
      async () => {
        const existing = await readJsonOrNull<unknown>(path);
        if (existing) throw new Error(`Project ${parsed.id} already exists`);
        await atomicWriteJson(path, parsed);
      },
    );
  }

  async get(projectId: string): Promise<Project | null> {
    const value = await readJsonOrNull<unknown>(this.pathFor(projectId));
    return value ? ProjectSchema.parse(value) : null;
  }

  async update(project: Project, expectedVersion: number): Promise<Project> {
    if (project.version !== expectedVersion) {
      throw new VersionConflictError('project', project.id, expectedVersion, project.version);
    }
    const path = this.pathFor(project.id);
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['projects', safeSegment(project.id), 'project.json.lock'],
      async () => {
        const existing = await this.get(project.id);
        if (!existing) throw new Error(`Project ${project.id} does not exist`);
        if (existing.version !== expectedVersion) {
          throw new VersionConflictError('project', project.id, expectedVersion, existing.version);
        }
        const updated = ProjectSchema.parse({ ...project, version: expectedVersion + 1 });
        await atomicWriteJson(path, updated);
        return updated;
      },
    );
  }

  async list(limit = 50): Promise<Project[]> {
    return (await this.readAll()).slice(0, limit);
  }

  async listAll(): Promise<Project[]> {
    return this.readAll();
  }

  private async readAll(): Promise<Project[]> {
    const root = join(this.dataDir, 'projects');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const projects = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.get(entry.name)),
    );

    return projects
      .filter((project): project is Project => project !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'project.json');
  }
}
