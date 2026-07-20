import { expect, it } from 'vitest';
import type { Project, ProjectEvent } from '@agent-foundry/contracts';
import { PostgresEventStore } from './event-store.js';
import { PostgresProjectRepository } from './project-repository.js';
import { describePostgres } from './testing.js';

const createdAt = '2026-07-14T12:00:00.000Z';

function makeProject(id = 'project-1'): Project {
  return {
    id,
    name: 'Project',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function event(id: string, projectId = 'project-1', dedupeKey?: string): ProjectEvent {
  return {
    id,
    projectId,
    type: 'node.started',
    createdAt,
    message: `event ${id}`,
    ...(dedupeKey ? { dedupeKey } : {}),
    data: {},
  };
}

describePostgres('Postgres event store', (ctx) => {
  it('drops a replayed event with the same dedupeKey (partial-index conflict target)', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresEventStore(sql);

    await store.append(event('event-1', 'project-1', 'run-1:node:plan:started'));
    await store.append(event('event-2', 'project-1', 'run-1:node:plan:started'));
    await store.append(event('event-3', 'project-1', 'run-1:node:implement:started'));

    const events = await store.list('project-1');
    expect(events.map((item) => item.id)).toEqual(['event-1', 'event-3']);
  });

  it('lists the last N events ascending with no cursor, and paginates after a cursor', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresEventStore(sql);

    const ids = ['evt-01', 'evt-02', 'evt-03', 'evt-04', 'evt-05', 'evt-06', 'evt-07'];
    for (const id of ids) await store.append(event(id));

    const tail = await store.list('project-1', 3);
    expect(tail.map((item) => item.id)).toEqual(['evt-05', 'evt-06', 'evt-07']);

    const afterSecond = await store.list('project-1', 3, 'evt-02');
    expect(afterSecond.map((item) => item.id)).toEqual(['evt-03', 'evt-04', 'evt-05']);
  });

  it('redacts sensitive data before persisting', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresEventStore(sql);

    await store.append({
      ...event('event-1'),
      message: 'Bearer abc123token456xyz789',
      data: { apiKey: 'x' },
    });

    const [persisted] = await store.list('project-1');
    expect(persisted?.message).toContain('[REDACTED]');
    expect(persisted?.data.apiKey).toBe('[REDACTED]');
  });

  it('rejects appending an event for an unknown project (FK violation)', async () => {
    const sql = ctx.db();
    const store = new PostgresEventStore(sql);

    await expect(store.append(event('event-1', 'missing-project'))).rejects.toThrow(
      /project_events/,
    );
  });
});
