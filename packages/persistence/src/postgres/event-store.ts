import { ProjectEventSchema, type ProjectEvent } from '@agent-foundry/contracts';
import { redactEvent, type EventStore } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { toJsonb } from './versioned.js';

export class PostgresEventStore implements EventStore {
  constructor(private readonly sql: PostgresDb) {}

  async append(event: ProjectEvent): Promise<void> {
    const parsed = redactEvent(ProjectEventSchema.parse(event));
    // The partial unique index (project_id, dedupe_key) where dedupe_key is not
    // null replaces the file store's full-file scan: a replayed emission with
    // the same dedupeKey is a silent no-op.
    await this.sql`
      insert into project_events (id, project_id, run_id, type, dedupe_key, created_at, data)
      values (
        ${parsed.id}, ${parsed.projectId}, ${parsed.runId ?? null}, ${parsed.type},
        ${parsed.dedupeKey ?? null}, ${parsed.createdAt}, ${toJsonb(this.sql, parsed)}
      )
      on conflict (project_id, dedupe_key) where dedupe_key is not null do nothing`;
  }

  async list(projectId: string, limit = 500, afterId?: string): Promise<ProjectEvent[]> {
    if (afterId === undefined) {
      const rows = await this.sql<{ data: unknown }[]>`
        select data from project_events
        where project_id = ${projectId}
        order by id desc
        limit ${limit}`;
      return rows.map((row) => ProjectEventSchema.parse(row.data)).reverse();
    }
    const rows = await this.sql<{ data: unknown }[]>`
      select data from project_events
      where project_id = ${projectId} and id > ${afterId}
      order by id asc
      limit ${limit}`;
    return rows.map((row) => ProjectEventSchema.parse(row.data));
  }
}
