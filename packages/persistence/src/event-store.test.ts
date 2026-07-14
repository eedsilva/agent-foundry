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
