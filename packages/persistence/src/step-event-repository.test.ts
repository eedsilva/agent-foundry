import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStepEventRepository } from './step-event-repository.js';

let dataDir: string;
let repository: FileStepEventRepository;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'step-events-'));
  repository = new FileStepEventRepository(dataDir);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('FileStepEventRepository', () => {
  it('assigns an increasing sequence per run and lists in order', async () => {
    const first = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'tool_start',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
    });
    const second = await repository.append({
      id: 'evt-2',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      createdAt: '2026-07-18T00:00:01.000Z',
      type: 'tool_end',
      toolName: 'Read',
      summary: 'Read: src/app.ts',
      ok: true,
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);

    const all = await repository.list('run-1');
    expect(all.map((event) => event.id)).toEqual(['evt-1', 'evt-2']);
  });

  it('filters by cursor for reconnect replay', async () => {
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

    const afterFirst = await repository.list('run-1', { cursor: 1 });
    expect(afterFirst.map((event) => event.id)).toEqual(['evt-2']);
  });

  it('scopes sequences independently per run', async () => {
    const runOneEvent = await repository.append({
      id: 'evt-1',
      runId: 'run-1',
      stepRunId: 'step-1',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });
    const runTwoEvent = await repository.append({
      id: 'evt-2',
      runId: 'run-2',
      stepRunId: 'step-2',
      createdAt: '2026-07-18T00:00:00.000Z',
      type: 'status',
      phase: 'started',
    });

    expect(runOneEvent.sequence).toBe(1);
    expect(runTwoEvent.sequence).toBe(1);
  });

  it('redacts assistant_delta text at write time', async () => {
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
