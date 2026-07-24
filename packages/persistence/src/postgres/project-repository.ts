import { ProjectSchema, type Project } from '@agent-foundry/contracts';
import type { ProjectRepository } from '@agent-foundry/domain';
import { VersionConflictError, type Tx } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { insertVersioned, updateVersioned } from './versioned.js';

function columnsFor(project: Project): Record<string, unknown> {
  return {
    status: project.status,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

export class PostgresProjectRepository implements ProjectRepository {
  constructor(private readonly sql: PostgresDb) {}

  async create(project: Project, tx?: Tx): Promise<void> {
    const parsed = ProjectSchema.parse(project);
    await insertVersioned((tx as unknown as PostgresDb | undefined) ?? this.sql, {
      table: 'projects',
      entity: 'project',
      id: parsed.id,
      version: parsed.version,
      columns: columnsFor(parsed),
      data: parsed,
    });
  }

  async get(projectId: string): Promise<Project | null> {
    const rows = await this.sql<
      { data: unknown }[]
    >`select data from projects where id = ${projectId}`;
    return rows[0] ? ProjectSchema.parse(rows[0].data) : null;
  }

  async update(project: Project, expectedVersion: number, tx?: Tx): Promise<Project> {
    if (project.version !== expectedVersion) {
      throw new VersionConflictError('project', project.id, expectedVersion, project.version);
    }
    const next = ProjectSchema.parse({ ...project, version: expectedVersion + 1 });
    await updateVersioned((tx as unknown as PostgresDb | undefined) ?? this.sql, {
      table: 'projects',
      entity: 'project',
      id: project.id,
      keyColumns: { id: project.id },
      expectedVersion,
      nextData: next,
      columns: columnsFor(next),
    });
    return next;
  }

  async list(limit = 50): Promise<Project[]> {
    const rows = await this.sql<
      { data: unknown }[]
    >`select data from projects order by created_at desc, id desc limit ${limit}`;
    return rows.map((row) => ProjectSchema.parse(row.data));
  }

  /** Unpaged — for sweeps (e.g. blob GC) that must see the whole set. */
  async listAll(): Promise<Project[]> {
    const rows = await this.sql<
      { data: unknown }[]
    >`select data from projects order by created_at desc, id desc`;
    return rows.map((row) => ProjectSchema.parse(row.data));
  }
}
