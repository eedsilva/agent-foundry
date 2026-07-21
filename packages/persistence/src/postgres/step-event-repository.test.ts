import { expect, it } from 'vitest';
import { PostgresStepEventRepository } from './step-event-repository.js';
import { describePostgres } from './testing.js';

describePostgres('Postgres step event repository', (ctx) => {
  it('assigns sequences 1..10 with no gaps or duplicates under 10 concurrent appends', async () => {
    const sql = ctx.db();
    const repository = new PostgresStepEventRepository(sql);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repository.append({
          id: `evt-${index + 1}`,
          runId: 'run-1',
          stepRunId: 'step-1',
          createdAt: '2026-07-18T00:00:00.000Z',
          type: 'status',
          phase: 'started',
        }),
      ),
    );

    expect(results.map((event) => event.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
  });

  it('lists events after a cursor in sequence order', async () => {
    const sql = ctx.db();
    const repository = new PostgresStepEventRepository(sql);

    await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });
    await repository.append({
      id: 'evt-2',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:01.000Z',
      type: 'status',
      phase: 'thinking',
    });
    await repository.append({
      id: 'evt-3',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:02.000Z',
      type: 'status',
      phase: 'done',
    });

    const after = await repository.list('run-1', { cursor: 1, limit: 5 });
    expect(after.map((event) => event.id)).toEqual(['evt-2', 'evt-3']);

    // No options: cursor defaults to 0 and the limit clause is omitted entirely.
    const all = await repository.list('run-1');
    expect(all.map((event) => event.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('redacts assistant_delta text at write time', async () => {
    const sql = ctx.db();
    const repository = new PostgresStepEventRepository(sql);

    const event = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'assistant_delta',
      text: 'export const OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwxyz012345";',
    });

    expect(event.type).toBe('assistant_delta');
    if (event.type === 'assistant_delta') {
      expect(event.text).toContain('[REDACTED]');
      expect(event.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
    }
  });
});
