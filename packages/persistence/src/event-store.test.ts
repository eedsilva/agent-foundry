import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectEvent } from '@agent-foundry/contracts';
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
});
