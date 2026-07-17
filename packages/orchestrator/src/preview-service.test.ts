import { describe, expect, it } from 'vitest';
import {
  PreviewFailureDiagnosticSchema,
  ProjectEventSchema,
  type PreviewHealth,
  type PreviewLogPage,
  type PreviewSession,
  type ProjectEvent,
} from '@agent-foundry/contracts';
import {
  PreviewAccessDeniedError,
  VersionConflictError,
  transitionPreviewSession,
  type Clock,
  type EventStore,
  type IdGenerator,
  type PreviewRunner,
  type PreviewSessionRecord,
  type PreviewSessionRepository,
} from '@agent-foundry/domain';
import { InMemoryArtifacts } from './testing/harness.js';
import { PreviewService, type PreviewServiceConfig } from './preview-service.js';

class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}

class InMemoryEventStore implements EventStore {
  readonly events: ProjectEvent[] = [];
  failPreviewFailedOnce = false;
  async append(event: ProjectEvent): Promise<void> {
    const parsed = ProjectEventSchema.parse(event);
    if (parsed.type === 'preview.failed' && this.failPreviewFailedOnce) {
      this.failPreviewFailedOnce = false;
      throw new Error('event store unavailable');
    }
    if (parsed.dedupeKey && this.events.some((item) => item.dedupeKey === parsed.dedupeKey)) return;
    this.events.push(parsed);
  }
  async list(projectId: string): Promise<ProjectEvent[]> {
    return this.events.filter((event) => event.projectId === projectId);
  }
}

class InMemoryPreviewSessions implements PreviewSessionRepository {
  readonly records = new Map<string, PreviewSessionRecord>();
  async create(record: PreviewSessionRecord): Promise<void> {
    if (this.records.has(record.session.id)) throw new Error('duplicate session');
    this.records.set(record.session.id, { ...record, session: sanitize(record.session) });
  }
  async get(sessionId: string): Promise<PreviewSessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }
  async listActive(): Promise<PreviewSessionRecord[]> {
    return [...this.records.values()].filter(
      ({ session }) => !['stopped', 'failed', 'expired'].includes(session.status),
    );
  }
  async update(session: PreviewSession, expectedVersion: number): Promise<PreviewSession> {
    const current = this.records.get(session.id)!;
    if (current.session.version !== expectedVersion || session.version !== expectedVersion) {
      throw new VersionConflictError(
        'preview-session',
        session.id,
        expectedVersion,
        current.session.version,
      );
    }
    const updated = sanitize({ ...session, version: expectedVersion + 1 });
    this.records.set(session.id, { session: updated, tokenDigest: current.tokenDigest });
    return updated;
  }
}

class SharedLifecycleLock {
  private readonly tails = new Map<string, Promise<void>>();
  async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.tails.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId);
    }
  }
}

function sanitize(session: PreviewSession): PreviewSession {
  if (!session.url) return session;
  const url = new URL(session.url);
  url.searchParams.delete('token');
  return { ...session, url: url.toString() };
}

class FakePreviewRunner implements PreviewRunner {
  healthResponses: PreviewHealth[] = [{ state: 'healthy', consecutiveFailures: 0 }];
  logsPage: PreviewLogPage = { entries: [], nextCursor: 0 };
  stopCount = 0;
  restartCount = 0;
  restartThrows = 0;
  logsThrows = 0;
  readonly stopFailures = new Set<string>();
  prepareFailureMessage?: string;
  restartFailureMessage?: string;

  async prepare(session: PreviewSession): Promise<PreviewSession> {
    if (this.prepareFailureMessage) {
      return transitionPreviewSession(session, 'failed', new Date(session.updatedAt), {
        health: {
          state: 'unhealthy',
          detail: this.prepareFailureMessage,
          consecutiveFailures: 1,
        },
        error: {
          name: 'PreviewInstallError',
          code: 'PREVIEW_INSTALL_FAILED',
          message: this.prepareFailureMessage,
        },
      });
    }
    return session;
  }
  async start(session: PreviewSession): Promise<PreviewSession> {
    return transitionPreviewSession(session, 'starting', new Date(session.updatedAt), {
      process: { command: 'node', args: [], port: 4100 },
    });
  }
  async health(): Promise<PreviewHealth> {
    return this.healthResponses.shift() ?? { state: 'healthy', consecutiveFailures: 0 };
  }
  async logs(): Promise<PreviewLogPage> {
    if (this.logsThrows > 0) {
      this.logsThrows -= 1;
      throw new Error('log store unavailable');
    }
    return this.logsPage;
  }
  async restart(session: PreviewSession): Promise<PreviewSession> {
    this.restartCount += 1;
    if (this.restartThrows > 0) {
      this.restartThrows -= 1;
      throw new Error(`restart ${this.restartCount} failed`);
    }
    if (this.restartFailureMessage) {
      return transitionPreviewSession(session, 'failed', new Date(session.updatedAt), {
        error: {
          name: 'PreviewRuntimeError',
          code: 'PREVIEW_RUNTIME_FAILED',
          message: this.restartFailureMessage,
        },
      });
    }
    return transitionPreviewSession(session, 'starting', new Date(session.updatedAt), {
      process: { command: 'node', args: [], port: 4100 + this.restartCount },
    });
  }
  async stop(session: PreviewSession): Promise<PreviewSession> {
    this.stopCount += 1;
    if (this.stopFailures.delete(session.id)) throw new Error(`stop ${session.id} failed`);
    if (
      session.status === 'stopped' ||
      session.status === 'failed' ||
      session.status === 'expired'
    ) {
      return session;
    }
    return transitionPreviewSession(session, 'stopped', new Date(session.updatedAt));
  }
}

async function buildService(
  options: {
    runner?: FakePreviewRunner;
    clock?: FixedClock;
    events?: InMemoryEventStore;
    sessions?: InMemoryPreviewSessions;
    artifacts?: InMemoryArtifacts;
    lifecycleLock?: SharedLifecycleLock;
    config?: Partial<PreviewServiceConfig>;
  } = {},
) {
  const runner = options.runner ?? new FakePreviewRunner();
  const clock = options.clock ?? new FixedClock(new Date('2026-07-16T12:00:00.000Z'));
  const events = options.events ?? new InMemoryEventStore();
  const sessions = options.sessions ?? new InMemoryPreviewSessions();
  const artifacts = options.artifacts ?? new InMemoryArtifacts({ on: true });
  const lifecycleLock = options.lifecycleLock ?? new SharedLifecycleLock();
  const service = new PreviewService(
    runner,
    sessions,
    lifecycleLock,
    artifacts,
    events,
    clock,
    new SequentialIds(),
    {
      previewBaseUrl: 'http://127.0.0.1:4000/preview',
      ttlSeconds: 60,
      healthIntervalMs: 1,
      ...options.config,
    },
  );
  return { service, runner, clock, events, sessions, artifacts, lifecycleLock };
}

async function start(service: PreviewService, runId?: string) {
  return service.start({
    workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
    ...(runId ? { runId } : {}),
  });
}

describe('PreviewService durable lifecycle', () => {
  it('waits through a slow startup and stores only the token digest while returning the tokenized shape', async () => {
    const runner = new FakePreviewRunner();
    runner.healthResponses = [
      { state: 'unhealthy', consecutiveFailures: 1 },
      { state: 'unhealthy', consecutiveFailures: 1 },
      { state: 'healthy', consecutiveFailures: 0 },
    ];
    const { service, sessions } = await buildService({ runner });

    const { session, url } = await start(service);
    const stored = await sessions.get(session.id);

    expect(session.status).toBe('running');
    expect(session.url).toBe(url);
    expect(new URL(url).searchParams.get('token')).toBeTruthy();
    expect(stored?.session.url).not.toContain('token=');
    expect(stored?.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(new URL(url).searchParams.get('token')!);
  });

  it('authenticates a presented token after a service restart without persisting the raw token', async () => {
    const first = await buildService();
    const { session, url } = await start(first.service);
    const token = new URL(url).searchParams.get('token')!;
    const restarted = await buildService({
      sessions: first.sessions,
      artifacts: first.artifacts,
      runner: first.runner,
    });

    await expect(restarted.service.resolveUpstream(session.id, token)).resolves.toEqual({
      port: 4100,
    });
    await expect(restarted.service.resolveUpstream(session.id, 'wrong')).rejects.toBeInstanceOf(
      PreviewAccessDeniedError,
    );
  });

  it('terminates a never-healthy preview before persisting failure and writes a structured diagnostic', async () => {
    const runner = new FakePreviewRunner();
    runner.healthResponses = [
      { state: 'unhealthy', detail: 'connection refused', consecutiveFailures: 1 },
    ];
    runner.logsPage = {
      entries: [
        {
          cursor: 1,
          stream: 'stderr',
          message: 'port never opened',
          timestamp: '2026-07-16T12:00:00.000Z',
        },
      ],
      nextCursor: 1,
    };
    const { service, sessions, artifacts } = await buildService({
      runner,
      config: { startupTimeoutMs: 0 },
    });

    const { session, url } = await start(service, 'run-1');
    const diagnostic = (await artifacts.getLatest('project-1', `preview-failure-${session.id}`))!;

    expect(session.status).toBe('failed');
    expect(url).toBe('');
    expect(runner.stopCount).toBe(1);
    expect((await sessions.get(session.id))?.session.status).toBe('failed');
    expect(diagnostic.metadata.runId).toBe('run-1');
    expect(PreviewFailureDiagnosticSchema.parse(diagnostic.content)).toMatchObject({
      sessionId: session.id,
      projectId: 'project-1',
      runId: 'run-1',
      phase: 'health',
      logs: runner.logsPage,
    });
  });

  it('restarts at most twice across a crash loop, then fails with deduplicated events and artifact', async () => {
    const runner = new FakePreviewRunner();
    runner.healthResponses = [
      { state: 'healthy', consecutiveFailures: 0 },
      { state: 'unhealthy', detail: 'crash 1', consecutiveFailures: 1 },
      { state: 'healthy', consecutiveFailures: 0 },
      { state: 'unhealthy', detail: 'crash 2', consecutiveFailures: 1 },
      { state: 'healthy', consecutiveFailures: 0 },
      { state: 'unhealthy', detail: 'crash 3', consecutiveFailures: 1 },
    ];
    const { service, events, artifacts } = await buildService({
      runner,
      config: { healthFailureThreshold: 1, maxRestarts: 2 },
    });
    const { session } = await start(service, 'run-1');

    await service.reap();
    await service.reap();
    await Promise.all([service.reap(), service.reap()]);

    expect(runner.restartCount).toBe(2);
    expect(runner.stopCount).toBe(1);
    expect(events.events.map((event) => event.type)).toEqual([
      'preview.crashed',
      'preview.restarted',
      'preview.crashed',
      'preview.restarted',
      'preview.crashed',
      'preview.failed',
    ]);
    expect(new Set(events.events.map((event) => event.dedupeKey)).size).toBe(6);
    expect(await artifacts.listMetadata('project-1', `preview-failure-${session.id}`)).toHaveLength(
      1,
    );
  });

  it('reaps expired and persisted orphan sessions after terminating the runner', async () => {
    const first = await buildService();
    const { session } = await start(first.service);
    first.clock.advance(61_000);
    const restarted = await buildService({
      sessions: first.sessions,
      artifacts: first.artifacts,
      runner: first.runner,
      clock: first.clock,
      events: first.events,
    });

    await restarted.service.reap();
    expect((await restarted.sessions.get(session.id))?.session.status).toBe('expired');

    await restarted.sessions.create({
      session: {
        id: 'orphan-1',
        workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
        status: 'preparing',
        version: 1,
        health: { state: 'unknown', consecutiveFailures: 0 },
        ttl: { seconds: 60 },
        restartCount: 0,
        createdAt: first.clock.now().toISOString(),
        updatedAt: first.clock.now().toISOString(),
      },
      tokenDigest: 'a'.repeat(64),
    });
    await restarted.service.reap();

    expect((await restarted.sessions.get('orphan-1'))?.session.status).toBe('stopped');
    expect(first.runner.stopCount).toBe(2);
    expect(first.events.events.filter((event) => event.type === 'preview.reaped')).toHaveLength(2);
  });

  it('serializes concurrent stop and reap calls without duplicate termination or lifecycle writes', async () => {
    const { service, runner, events } = await buildService();
    const { session } = await start(service);

    await Promise.all([service.stop(session.id), service.stop(session.id), service.reap()]);

    expect(runner.stopCount).toBe(1);
    expect(events.events.filter((event) => event.type === 'preview.reaped')).toHaveLength(0);
  });

  it('returns bounded cursor pages through the public logs method', async () => {
    const { service, runner } = await buildService();
    const { session } = await start(service);
    runner.logsPage = { entries: [], nextCursor: 12, truncatedBeforeCursor: 5 };

    await expect(service.logs(session.id, 10, 25)).resolves.toEqual(runner.logsPage);
  });

  it('serializes lifecycle side effects across two service instances sharing storage', async () => {
    const runner = new FakePreviewRunner();
    runner.healthResponses = [
      { state: 'healthy', consecutiveFailures: 0 },
      { state: 'unhealthy', consecutiveFailures: 1 },
      { state: 'healthy', consecutiveFailures: 0 },
    ];
    const first = await buildService({
      runner,
      config: { healthFailureThreshold: 1, maxRestarts: 1 },
    });
    const second = await buildService({
      runner,
      sessions: first.sessions,
      artifacts: first.artifacts,
      events: first.events,
      clock: first.clock,
      lifecycleLock: first.lifecycleLock,
      config: { healthFailureThreshold: 1, maxRestarts: 1 },
    });
    const { session } = await start(first.service, 'run-1');

    await Promise.all([first.service.reap(), second.service.reap()]);
    runner.healthResponses = [{ state: 'unhealthy', consecutiveFailures: 1 }];
    await Promise.all([first.service.reap(), second.service.reap()]);

    expect(runner.restartCount).toBe(1);
    expect(runner.stopCount).toBe(1);
    expect(first.events.events.map((event) => event.type)).toEqual([
      'preview.crashed',
      'preview.restarted',
      'preview.crashed',
      'preview.failed',
    ]);
    expect(
      await first.artifacts.listMetadata('project-1', `preview-failure-${session.id}`),
    ).toHaveLength(1);
    expect((await first.sessions.get(session.id))?.session.status).toBe('failed');
  });

  it('continues a sweep after one session fails and surfaces the collected errors', async () => {
    const built = await buildService();
    const first = await start(built.service);
    const second = await start(built.service);
    built.clock.advance(61_000);
    built.runner.stopFailures.add(first.session.id);

    await expect(built.service.reap()).rejects.toBeInstanceOf(AggregateError);

    expect((await built.sessions.get(first.session.id))?.session.status).toBe('running');
    expect((await built.sessions.get(second.session.id))?.session.status).toBe('expired');
  });

  it('reserves thrown restart attempts durably and fails after exactly two attempts', async () => {
    const runner = new FakePreviewRunner();
    runner.restartThrows = 2;
    runner.healthResponses = [
      { state: 'healthy', consecutiveFailures: 0 },
      { state: 'unhealthy', consecutiveFailures: 1 },
      { state: 'unhealthy', consecutiveFailures: 1 },
    ];
    const built = await buildService({
      runner,
      config: { healthFailureThreshold: 1, maxRestarts: 2 },
    });
    const { session } = await start(built.service);

    await expect(built.service.reap()).rejects.toBeInstanceOf(AggregateError);
    expect((await built.sessions.get(session.id))?.session.restartCount).toBe(1);
    await built.service.reap();

    expect(runner.restartCount).toBe(2);
    expect((await built.sessions.get(session.id))?.session).toMatchObject({
      status: 'failed',
      restartCount: 2,
      error: { code: 'PREVIEW_RESTART_FAILED' },
    });
    expect(
      await built.artifacts.listMetadata('project-1', `preview-failure-${session.id}`),
    ).toHaveLength(1);
  });

  it.each(['event', 'logs', 'artifact'] as const)(
    'replays incomplete %s evidence before making failure terminal',
    async (failure) => {
      const runner = new FakePreviewRunner();
      runner.healthResponses = [{ state: 'unhealthy', consecutiveFailures: 1 }];
      const built = await buildService({ runner, config: { startupTimeoutMs: 0 } });
      if (failure === 'event') built.events.failPreviewFailedOnce = true;
      if (failure === 'logs') runner.logsThrows = 1;
      if (failure === 'artifact') {
        built.artifacts.onAfterPut = () => {
          built.artifacts.onAfterPut = undefined;
          throw new Error('artifact store interrupted after put');
        };
      }

      await expect(start(built.service)).rejects.toThrow();
      expect((await built.sessions.get('id-1'))?.session.status).toBe('failing');
      const restarted = await buildService({
        runner,
        sessions: built.sessions,
        artifacts: built.artifacts,
        events: built.events,
        clock: built.clock,
        lifecycleLock: built.lifecycleLock,
        config: { startupTimeoutMs: 0 },
      });

      await restarted.service.reap();

      expect((await built.sessions.get('id-1'))?.session.status).toBe('failed');
      expect(built.events.events.filter((event) => event.type === 'preview.failed')).toHaveLength(
        1,
      );
      expect(await built.artifacts.listMetadata('project-1', 'preview-failure-id-1')).toHaveLength(
        1,
      );
    },
  );

  it.each(['install', 'runtime'] as const)(
    'redacts secrets from %s failure diagnostics at the artifact boundary',
    async (phase) => {
      const secret = `ghp_${'a'.repeat(24)}`;
      const runner = new FakePreviewRunner();
      runner.logsPage = {
        entries: [
          {
            cursor: 1,
            stream: 'stderr',
            message: `Authorization: Bearer ${secret}`,
            timestamp: '2026-07-16T12:00:00.000Z',
          },
        ],
        nextCursor: 1,
      };
      if (phase === 'install') runner.prepareFailureMessage = `token=${secret}`;
      else {
        runner.restartFailureMessage = `Authorization: Bearer ${secret}`;
        runner.healthResponses = [
          { state: 'healthy', consecutiveFailures: 0 },
          { state: 'unhealthy', detail: `token=${secret}`, consecutiveFailures: 1 },
        ];
      }
      const built = await buildService({
        runner,
        config: { healthFailureThreshold: 1 },
      });
      const result = await start(built.service);
      if (phase === 'runtime') await built.service.reap();

      const artifact = await built.artifacts.getLatest(
        'project-1',
        `preview-failure-${result.session.id}`,
      );
      const serialized = JSON.stringify(artifact);
      expect(serialized).not.toContain(secret);
      expect(serialized).toContain('[REDACTED]');
    },
  );
});
