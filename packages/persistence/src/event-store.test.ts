import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PreviewFailureDiagnosticSchema,
  type PreviewFailureDiagnostic,
  type ProjectEvent,
} from '@agent-foundry/contracts';
import { FileEventStore } from './event-store.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-events-'));
  temporaryDirectories.push(path);
  return path;
}

function event(id: string, dedupeKey?: string): ProjectEvent {
  return {
    id,
    projectId: 'project-1',
    type: 'node.started',
    createdAt: new Date().toISOString(),
    message: `event ${id}`,
    ...(dedupeKey ? { dedupeKey } : {}),
    data: {},
  };
}

describe('FileEventStore idempotent append', () => {
  it('drops a replayed event with the same dedupeKey', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    await store.append(event('event-1', 'run-1:node:plan:started'));
    await store.append(event('event-2', 'run-1:node:plan:started'));
    await store.append(event('event-3', 'run-1:node:implement:started'));

    const events = await store.list('project-1');
    expect(events.map((item) => item.id)).toEqual(['event-1', 'event-3']);
  });

  it('keeps appending events without a dedupeKey', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    await store.append(event('event-1'));
    await store.append(event('event-2'));

    expect(await store.list('project-1')).toHaveLength(2);
  });
});

describe('FileEventStore.list cursor', () => {
  it('lists events after a cursor id without duplication', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    const e1 = event('01A');
    const e2 = event('01B');
    const e3 = event('01C');
    const e4 = event('01D');
    const e5 = event('01E');
    for (const e of [e1, e2, e3, e4, e5]) await store.append(e);

    const after = await store.list('project-1', 500, e3.id);
    expect(after.map((item) => item.id)).toEqual([e4.id, e5.id]);
  });

  it('falls back to id-ordering when the cursor id is unknown (e.g. truncated file)', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    const e1 = event('01A');
    const e2 = event('01B');
    const e3 = event('01C');
    const e4 = event('01D');
    const e5 = event('01E');
    for (const e of [e1, e2, e3, e4, e5]) await store.append(e);

    // '01C1' sorts strictly between e3 ('01C') and e4 ('01D') but is not a known id.
    const after = await store.list('project-1', 500, '01C1');
    expect(after.map((item) => item.id)).toEqual([e4.id, e5.id]);
  });
});

describe('FileEventStore.findLatest', () => {
  it('finds a durable run event after it leaves the default 500-event window', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    await store.append({
      ...event('000-provisioned'),
      runId: 'run-1',
      type: 'project.provisioned',
    });
    for (let index = 1; index <= 501; index += 1) {
      await store.append(event(`event-${String(index).padStart(3, '0')}`));
    }

    expect(await store.list('project-1')).toHaveLength(500);
    await expect(
      store.findLatest('project-1', { type: 'project.provisioned', runId: 'run-1' }),
    ).resolves.toMatchObject({ id: '000-provisioned' });
  });
});

describe('FileEventStore redaction on append', () => {
  it('redacts sensitive data before persisting', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    await store.append({
      ...event('event-1'),
      message: 'Bearer abcdef1234567890ABCDEF',
      data: { apiKey: 'x' },
    });

    const [persisted] = await store.list('project-1');
    expect(persisted?.message).toContain('[REDACTED]');
    expect(persisted?.data.apiKey).toBe('[REDACTED]');
  });

  it('revalidates structured diagnostics after redaction expands a log', async () => {
    const store = new FileEventStore(await temporaryDataDir());
    await expect(
      store.append({
        ...event('event-1'),
        type: 'project.provisioning_failed',
        data: {
          diagnostic: {
            schemaVersion: '1',
            phase: 'start',
            summary: 'failed',
            context: 'context',
            logs: `${'x'.repeat(8181)} PASSWORD=x`,
          },
        },
      }),
    ).rejects.toThrow();
  });

  it('round-trips a preview.failed diagnostic, redacting secrets without mangling recovery-critical structure', async () => {
    const secret = 'sk-abc123def456ghi789jkl';
    const diagnostic: PreviewFailureDiagnostic = PreviewFailureDiagnosticSchema.parse({
      schemaVersion: '1',
      sessionId: 'preview-1',
      projectId: 'project-1',
      runId: 'run-1',
      phase: 'runtime',
      health: {
        state: 'unhealthy',
        checkedAt: '2026-08-14T00:00:00.000Z',
        detail: 'process exited',
        consecutiveFailures: 3,
      },
      restartCount: 2,
      error: { name: 'PreviewCrashLoop', message: 'restart limit reached', exitCode: 1 },
      logs: {
        entries: [
          {
            cursor: 9,
            stream: 'stderr',
            message: `build failed: ${secret}`,
            timestamp: '2026-08-14T00:00:00.000Z',
          },
        ],
        nextCursor: 9,
        truncatedBeforeCursor: 9,
      },
      command: { command: 'npm', args: ['run', 'dev'] },
      exitCode: 1,
      output: { stdout: 'starting up', stderr: `fatal: ${secret} leaked` },
      failedAt: '2026-08-14T00:00:00.000Z',
    });

    const store = new FileEventStore(await temporaryDataDir());
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
