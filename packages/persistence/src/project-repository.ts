import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, type Project } from '@agent-foundry/contracts';
import type { ProjectRepository } from '@agent-foundry/domain';
import { atomicWriteJson, ensureDir, readJsonOrNull, safeSegment } from './fs-utils.js';

export class FileProjectRepository implements ProjectRepository {
  constructor(private readonly dataDir: string) {}

  async create(project: Project): Promise<void> {
    const parsed = ProjectSchema.parse(project);
    const path = this.pathFor(parsed.id);
    const existing = await readJsonOrNull<unknown>(path);
    if (existing) throw new Error(`Project ${parsed.id} already exists`);
    await atomicWriteJson(path, parsed);
  }

  async get(projectId: string): Promise<Project | null> {
    const value = await readJsonOrNull<unknown>(this.pathFor(projectId));
    return value ? ProjectSchema.parse(value) : null;
  }

  async update(project: Project): Promise<void> {
    await atomicWriteJson(this.pathFor(project.id), ProjectSchema.parse(project));
  }

  async list(limit = 50): Promise<Project[]> {
    const root = join(this.dataDir, 'projects');
    await ensureDir(root);
    const entries = await readdir(root, { withFileTypes: true });
    const projects = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.get(entry.name)),
    );

    return projects
      .filter((project): project is Project => project !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  private pathFor(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'project.json');
  }
}
