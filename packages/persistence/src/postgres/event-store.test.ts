import { expect, it } from 'vitest';
import {
  PreviewFailureDiagnosticSchema,
  type PreviewFailureDiagnostic,
  type Project,
  type ProjectEvent,
} from '@agent-foundry/contracts';
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

  it('finds the latest event by type and optional run', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresEventStore(sql);
    await store.append({ ...event('evt-01'), runId: 'run-1', type: 'project.provisioned' });
    await store.append({ ...event('evt-02'), runId: 'run-2', type: 'project.provisioned' });

    await expect(
      store.findLatest('project-1', { type: 'project.provisioned', runId: 'run-1' }),
    ).resolves.toMatchObject({ id: 'evt-01' });
    await expect(
      store.findLatest('project-1', { type: 'project.provisioned' }),
    ).resolves.toMatchObject({ id: 'evt-02' });
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

  it('round-trips a preview.failed diagnostic, redacting secrets without mangling recovery-critical structure', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(makeProject());
    const store = new PostgresEventStore(sql);

    const secret = 'sk-abc123def456ghi789jkl';
    const diagnostic: PreviewFailureDiagnostic = PreviewFailureDiagnosticSchema.parse({
      schemaVersion: '1',
      sessionId: 'preview-1',
      projectId: 'project-1',
      runId: 'run-1',
      phase: 'runtime',
      health: {
        state: 'unhealthy',
        checkedAt: createdAt,
        detail: 'process exited',
        consecutiveFailures: 3,
      },
      restartCount: 2,
      error: { name: 'PreviewCrashLoop', message: 'restart limit reached', exitCode: 1 },
      logs: {
        entries: [
          { cursor: 9, stream: 'stderr', message: `build failed: ${secret}`, timestamp: createdAt },
        ],
        nextCursor: 9,
        truncatedBeforeCursor: 9,
      },
      command: { command: 'npm', args: ['run', 'dev'] },
      exitCode: 1,
      output: { stdout: 'starting up', stderr: `fatal: ${secret} leaked` },
      failedAt: createdAt,
    });

    await store.append({
      ...event('event-1'),
      type: 'preview.failed',
      message: 'preview failed',
      data: { sessionId: 'preview-1', status: 'failed', restartCount: 2, diagnostic },
    });

    const [persisted] = await store.list('project-1');
    const persistedDiagnostic = persisted?.data.diagnostic as PreviewFailureDiagnostic;

    // Recovery-critical structure survives the round trip unchanged.
    expect(persistedDiagnostic.phase).toBe('runtime');
    expect(persistedDiagnostic.exitCode).toBe(1);
    expect(persistedDiagnostic.command).toEqual({ command: 'npm', args: ['run', 'dev'] });
    expect(persistedDiagnostic.logs.entries[0]?.cursor).toBe(9);
    expect(persistedDiagnostic.logs.nextCursor).toBe(9);
    expect(persistedDiagnostic.output?.stdout).toBe('starting up');

    expect(persistedDiagnostic.sessionId).toBe('preview-1');
    expect(persisted?.data.sessionId).toBe('preview-1');

    // The planted secret is gone from both evidence surfaces, replaced with the
    // exact placeholder redactString produces, and the surrounding text survives.
    expect(persistedDiagnostic.output?.stderr).toBe('fatal: [REDACTED] leaked');
    expect(persistedDiagnostic.output?.stderr).not.toContain(secret);
    expect(persistedDiagnostic.logs.entries[0]?.message).toBe(`build failed: [REDACTED]`);
    expect(persistedDiagnostic.logs.entries[0]?.message).not.toContain(secret);
  });
});
