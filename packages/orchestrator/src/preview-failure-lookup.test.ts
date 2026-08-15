import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ArtifactMetadata, ProjectEvent, StoredArtifact } from '@agent-foundry/contracts';
import type { ArtifactStore, EventStore } from '@agent-foundry/domain';
import { latestPreviewFailureEvent } from './preview-failure-lookup.js';

// Mirrors FileEventStore.list exactly: newest `limit` events, ascending order,
// so the widening-scan regression test proves something real.
class FakeEventStore implements EventStore {
  constructor(private readonly events: ProjectEvent[] = []) {}
  async append(event: ProjectEvent): Promise<void> {
    this.events.push(event);
  }
  async list(projectId: string, limit = 500, afterId?: string): Promise<ProjectEvent[]> {
    const projectEvents = this.events.filter((event) => event.projectId === projectId);
    if (afterId === undefined) return projectEvents.slice(-limit);
    const index = projectEvents.findIndex((event) => event.id === afterId);
    const after =
      index >= 0
        ? projectEvents.slice(index + 1)
        : projectEvents.filter((event) => event.id > afterId);
    return after.slice(0, limit);
  }
}

class FakeArtifactStore implements ArtifactStore {
  readonly getLatestCalls: Array<{ projectId: string; name: string }> = [];
  constructor(private readonly byKey = new Map<string, StoredArtifact>()) {}
  async getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    this.getLatestCalls.push({ projectId, name });
    return this.byKey.get(`${projectId}/${name}`) ?? null;
  }
  put(): Promise<StoredArtifact> {
    throw new Error('not implemented');
  }
  putBlob(): Promise<ArtifactMetadata> {
    throw new Error('not implemented');
  }
  getBlobStream(): Promise<Readable | null> {
    throw new Error('not implemented');
  }
  getRevision(): Promise<StoredArtifact | null> {
    throw new Error('not implemented');
  }
  listLatest(): Promise<StoredArtifact[]> {
    throw new Error('not implemented');
  }
  listMetadata(): Promise<ArtifactMetadata[]> {
    throw new Error('not implemented');
  }
  reapExpired(): Promise<number> {
    throw new Error('not implemented');
  }
}

function previewFailedEvent(overrides: Partial<ProjectEvent> = {}): ProjectEvent {
  return {
    id: `event-${Math.random()}`,
    projectId: 'project-1',
    type: 'preview.failed',
    createdAt: '2026-08-14T00:00:00.000Z',
    message: 'preview failed',
    data: { sessionId: 'session-1', diagnostic: { schemaVersion: '1' } },
    ...overrides,
  };
}

function otherEvent(id: string): ProjectEvent {
  return {
    id,
    projectId: 'project-1',
    type: 'preview.restarted',
    createdAt: '2026-08-14T00:00:00.000Z',
    message: 'preview restarted',
    data: {},
  };
}

describe('latestPreviewFailureEvent', () => {
  it('returns the newest preview.failed event when several exist within the first page', async () => {
    const older = previewFailedEvent({ id: 'e1', data: { sessionId: 'session-old' } });
    const newer = previewFailedEvent({ id: 'e2', data: { sessionId: 'session-new' } });
    const events = new FakeEventStore([older, otherEvent('mid'), newer]);
    const artifacts = new FakeArtifactStore();

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.id).toBe('e2');
  });

  it('finds a preview.failed event buried behind more than 500 later events', async () => {
    const buried = previewFailedEvent({ id: 'buried', data: { sessionId: 'session-buried' } });
    const filler = Array.from({ length: 600 }, (_, i) => otherEvent(`filler-${i}`));
    const events = new FakeEventStore([buried, ...filler]);
    const artifacts = new FakeArtifactStore();

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.id).toBe('buried');
  });

  it('returns undefined without looping forever when there is no preview.failed event', async () => {
    const events = new FakeEventStore([otherEvent('a'), otherEvent('b')]);
    const artifacts = new FakeArtifactStore();

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found).toBeUndefined();
  });

  it('enriches an event with no data.diagnostic from the legacy artifact', async () => {
    const legacy = previewFailedEvent({
      id: 'legacy',
      data: { sessionId: 'session-legacy' },
    });
    const events = new FakeEventStore([legacy]);
    const artifacts = new FakeArtifactStore(
      new Map([
        [
          'project-1/preview-failure-session-legacy',
          { metadata: {} as ArtifactMetadata, content: { schemaVersion: '1', summary: 'oops' } },
        ],
      ]),
    );

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.data.diagnostic).toEqual({ schemaVersion: '1', summary: 'oops' });
    expect(legacy.data.diagnostic).toBeUndefined();
  });

  it('leaves the event untouched when the legacy artifact is absent', async () => {
    const legacy = previewFailedEvent({ id: 'legacy', data: { sessionId: 'session-legacy' } });
    const events = new FakeEventStore([legacy]);
    const artifacts = new FakeArtifactStore();

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.data.diagnostic).toBeUndefined();
    expect(artifacts.getLatestCalls).toEqual([
      { projectId: 'project-1', name: 'preview-failure-session-legacy' },
    ]);
  });

  it('does not consult the artifact store when data.diagnostic is already present', async () => {
    const withDiagnostic = previewFailedEvent({
      id: 'has-diagnostic',
      data: { sessionId: 'session-1', diagnostic: { schemaVersion: '1' } },
    });
    const events = new FakeEventStore([withDiagnostic]);
    const artifacts = new FakeArtifactStore();

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.data.diagnostic).toEqual({ schemaVersion: '1' });
    expect(artifacts.getLatestCalls).toEqual([]);
  });

  it('returns the event unchanged when the legacy artifact lookup throws', async () => {
    const legacy = previewFailedEvent({ id: 'legacy', data: { sessionId: 'session-legacy' } });
    const events = new FakeEventStore([legacy]);
    const artifacts = new FakeArtifactStore();
    artifacts.getLatest = async () => {
      throw new Error('artifact store unavailable');
    };

    const found = await latestPreviewFailureEvent(events, artifacts, 'project-1');

    expect(found?.data.diagnostic).toBeUndefined();
  });
});
