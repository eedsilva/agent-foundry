import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PreviewFailureDiagnosticSchema,
  PreviewSessionSchema,
  type PreviewFailurePhase,
  type PreviewHealth,
  type PreviewLogPage,
  type PreviewSession,
  type PreviewWorkspaceRef,
  type ProjectEvent,
} from '@agent-foundry/contracts';
import {
  NotFoundError,
  PreviewAccessDeniedError,
  expirePreviewSession,
  isPreviewSessionExpired,
  isPreviewSessionTerminal,
  redactString,
  redactUnknown,
  transitionPreviewSession,
  type ArtifactStore,
  type Clock,
  type EventStore,
  type IdGenerator,
  type PreviewRunner,
  type PreviewLifecycleLock,
  type PreviewSessionRepository,
} from '@agent-foundry/domain';

export interface PreviewServiceConfig {
  previewBaseUrl: string;
  ttlSeconds: number;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  healthFailureThreshold?: number;
  maxRestarts?: number;
}

interface StartPreviewInput {
  workspaceRef: PreviewWorkspaceRef;
  runId?: string;
}

interface ResolvedUpstream {
  port: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_INTERVAL_MS = 1_000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const DEFAULT_MAX_RESTARTS = 2;
const DIAGNOSTIC_LOG_LIMIT = 200;

/** Durable preview lifecycle policy. Scheduling remains owned by the API process. */
export class PreviewService {
  private readonly startupTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly healthFailureThreshold: number;
  private readonly maxRestarts: number;
  constructor(
    private readonly runner: PreviewRunner,
    private readonly sessions: PreviewSessionRepository,
    private readonly lifecycleLock: PreviewLifecycleLock,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly config: PreviewServiceConfig,
  ) {
    this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.healthIntervalMs = config.healthIntervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.healthFailureThreshold = config.healthFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD;
    this.maxRestarts = config.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  }

  async start(input: StartPreviewInput): Promise<{ session: PreviewSession; url: string }> {
    const sessionId = this.ids.next();
    const token = mintToken();
    return this.lifecycleLock.withSessionLock(sessionId, async () => {
      const now = this.clock.now().toISOString();
      let session: PreviewSession = {
        id: sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        workspaceRef: input.workspaceRef,
        status: 'preparing',
        version: 1,
        health: { state: 'unknown', consecutiveFailures: 0 },
        ttl: { seconds: this.config.ttlSeconds },
        restartCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.sessions.create({ session, tokenDigest: digestToken(token) });

      try {
        session = await this.runner.prepare(session);
      } catch (error) {
        const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
          failurePhase: 'prepare',
          error: {
            name: 'PreviewPrepareError',
            code: 'PREVIEW_PREPARE_FAILED',
            message: error instanceof Error ? error.message : 'Preview preparation failed.',
          },
        });
        session = await this.finalizeFailure(failing);
        return { session, url: '' };
      }
      if (isPreviewSessionTerminal(session.status)) {
        session = await this.finalizeFailure(this.stageFailure(session, 'prepare'));
        return { session, url: '' };
      }
      session = await this.persist(session);

      try {
        session = await this.runner.start(session);
      } catch (error) {
        const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
          failurePhase: 'start',
          error: {
            name: 'PreviewStartError',
            code: 'PREVIEW_START_FAILED',
            message: error instanceof Error ? error.message : 'Preview start failed.',
          },
        });
        session = await this.finalizeFailure(failing);
        return { session, url: '' };
      }
      if (isPreviewSessionTerminal(session.status)) {
        session = await this.finalizeFailure(this.stageFailure(session, 'start'));
        return { session, url: '' };
      }
      try {
        session = await this.persist(session);

        const health = await this.waitForHealthy(session);
        if (health.state !== 'healthy') {
          const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
            failurePhase: 'health',
            health,
            error: {
              name: 'PreviewUnhealthyError',
              code: 'PREVIEW_UNHEALTHY',
              message: 'Dev server did not become healthy in time.',
            },
          });
          session = await this.finalizeFailure(failing);
          return { session, url: '' };
        }

        const url = this.buildUrl(session.id, token);
        const running = transitionPreviewSession(session, 'running', this.clock.now(), {
          url,
          health: { ...health, consecutiveFailures: 0 },
        });
        session = await this.persist(running);
        return { session: { ...session, url }, url };
      } catch (error) {
        await this.cleanupStartedPreview(session, error);
        throw error;
      }
    });
  }

  async stop(sessionId: string): Promise<PreviewSession> {
    return this.lifecycleLock.withSessionLock(sessionId, async () => {
      const record = await this.requireSession(sessionId);
      if (isPreviewSessionTerminal(record.session.status)) return record.session;
      if (record.session.status === 'failing') {
        return this.finalizeFailure(record.session);
      }
      return this.persist(await this.runner.stop(record.session));
    });
  }

  async logs(sessionId: string, cursor?: number, limit?: number): Promise<PreviewLogPage> {
    const { session } = await this.requireSession(sessionId);
    return this.runner.logs(session, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  async resolveUpstream(sessionId: string, token: string | undefined): Promise<ResolvedUpstream> {
    return this.lifecycleLock.withSessionLock(sessionId, async () => {
      const record = await this.requireSession(sessionId);
      let session = record.session;
      if (session.status === 'failing') {
        throw new PreviewAccessDeniedError(sessionId, 'session failure is being finalized');
      }
      if (
        !isPreviewSessionTerminal(session.status) &&
        isPreviewSessionExpired(session, this.clock.now())
      ) {
        await this.runner.stop(session);
        session = await this.persist(expirePreviewSession(session, this.clock.now()));
        await this.emit(session, 'preview.reaped', 'expired preview session reaped', 'expired');
      }
      if (isPreviewSessionTerminal(session.status)) {
        throw new PreviewAccessDeniedError(sessionId, `session is ${session.status}`);
      }
      if (!token || !constantTimeEquals(digestToken(token), record.tokenDigest)) {
        throw new PreviewAccessDeniedError(sessionId, 'token mismatch');
      }
      if (!session.process?.port) {
        throw new PreviewAccessDeniedError(sessionId, 'session has no upstream port');
      }
      return { port: session.process.port };
    });
  }

  /** Performs one deterministic lifecycle sweep; callers own scheduling. */
  async reap(): Promise<number> {
    const active = await this.sessions.listActive();
    let reaped = 0;
    const failures: unknown[] = [];
    for (const record of active) {
      try {
        reaped += await this.lifecycleLock.withSessionLock(record.session.id, async () =>
          this.reapSession(record.session.id),
        );
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Preview lifecycle sweep failed.');
    return reaped;
  }

  private async reapSession(sessionId: string): Promise<number> {
    const record = await this.sessions.get(sessionId);
    if (!record || isPreviewSessionTerminal(record.session.status)) return 0;
    let session = record.session;

    if (session.status === 'failing') {
      await this.finalizeFailure(session);
      return 1;
    }

    if (isPreviewSessionExpired(session, this.clock.now())) {
      await this.runner.stop(session);
      session = await this.persist(expirePreviewSession(session, this.clock.now()));
      await this.emit(session, 'preview.reaped', 'expired preview session reaped', 'expired');
      return 1;
    }

    if (session.status === 'preparing' || session.status === 'starting') {
      session = await this.persist(await this.runner.stop(session));
      await this.emit(session, 'preview.reaped', 'orphan preview session reaped', 'orphan');
      return 1;
    }

    const probed = await this.runner.health(session);
    if (probed.state === 'healthy') {
      const health = { ...probed, consecutiveFailures: 0 };
      if (session.status === 'unhealthy') {
        session = transitionPreviewSession(session, 'running', this.clock.now(), { health });
      } else {
        session = { ...session, health, updatedAt: this.clock.now().toISOString() };
      }
      await this.persist(session);
      return 0;
    }

    const health: PreviewHealth = {
      ...probed,
      checkedAt: probed.checkedAt ?? this.clock.now().toISOString(),
      consecutiveFailures: session.health.consecutiveFailures + 1,
    };
    if (health.consecutiveFailures < this.healthFailureThreshold) {
      await this.persist({ ...session, health, updatedAt: this.clock.now().toISOString() });
      return 0;
    }
    if (session.status === 'running') {
      session = transitionPreviewSession(session, 'unhealthy', this.clock.now(), { health });
      session = await this.persist(session);
    }
    await this.emit(
      session,
      'preview.crashed',
      'preview process became unhealthy',
      String(session.restartCount),
    );

    if (session.restartCount >= this.maxRestarts) {
      const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
        failurePhase: 'runtime',
        health,
        error: {
          name: 'PreviewCrashLoopError',
          code: 'PREVIEW_RESTART_LIMIT',
          message: `Preview restart limit of ${this.maxRestarts} reached.`,
        },
      });
      await this.finalizeFailure(failing);
      return 1;
    }

    session = await this.persist({
      ...session,
      restartCount: session.restartCount + 1,
      updatedAt: this.clock.now().toISOString(),
    });
    let restarted: PreviewSession;
    try {
      restarted = await this.runner.restart(session);
    } catch (error) {
      if (session.restartCount >= this.maxRestarts) {
        const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
          failurePhase: 'runtime',
          health,
          error: {
            name: 'PreviewRestartError',
            code: 'PREVIEW_RESTART_FAILED',
            message: error instanceof Error ? error.message : 'Preview restart failed.',
          },
        });
        await this.finalizeFailure(failing);
        return 1;
      }
      throw error;
    }
    session = { ...restarted, restartCount: session.restartCount };
    if (isPreviewSessionTerminal(session.status)) {
      await this.finalizeFailure(this.stageFailure(session, 'runtime'));
      return 1;
    }
    session = await this.persist(session);
    const restartedHealth = await this.waitForHealthy(session);
    if (restartedHealth.state !== 'healthy') {
      const failing = transitionPreviewSession(session, 'failing', this.clock.now(), {
        failurePhase: 'health',
        health: restartedHealth,
        error: {
          name: 'PreviewUnhealthyError',
          code: 'PREVIEW_UNHEALTHY',
          message: 'Restarted dev server did not become healthy in time.',
        },
      });
      await this.finalizeFailure(failing);
      return 1;
    }
    session = transitionPreviewSession(session, 'running', this.clock.now(), {
      health: { ...restartedHealth, consecutiveFailures: 0 },
    });
    session = await this.persist(session);
    await this.emit(
      session,
      'preview.restarted',
      'preview process restarted',
      String(session.restartCount),
    );
    return 0;
  }

  private async finalizeFailure(failing: PreviewSession): Promise<PreviewSession> {
    const current = await this.requireSession(failing.id);
    let session = current.session;
    if (session.status !== 'failing') {
      session = await this.persist({ ...failing, version: session.version });
    }
    await this.runner.stop(session);
    const failedAt = new Date(session.updatedAt);
    await this.writeFailureDiagnostic(session, session.failurePhase!, failedAt);
    await this.emit(
      session,
      'preview.failed',
      session.error?.message ?? 'preview failed',
      'terminal',
    );
    return this.persist(transitionPreviewSession(session, 'failed', failedAt));
  }

  private async cleanupStartedPreview(session: PreviewSession, error: unknown): Promise<void> {
    try {
      const current = await this.sessions.get(session.id);
      const active = current?.session ?? session;
      if (isPreviewSessionTerminal(active.status)) return;
      if (active.status === 'failing') {
        await this.runner.stop(active);
        return;
      }
      const failing = transitionPreviewSession(active, 'failing', this.clock.now(), {
        failurePhase: 'start',
        error: {
          name: 'PreviewStartError',
          code: 'PREVIEW_START_FAILED',
          message: error instanceof Error ? error.message : 'Preview startup failed.',
        },
      });
      await this.finalizeFailure(failing);
    } catch {
      try {
        await this.runner.stop(session);
      } catch {
        // Preserve the original startup failure; lifecycle recovery can retry cleanup.
      }
    }
  }

  private async writeFailureDiagnostic(
    session: PreviewSession,
    phase: PreviewFailurePhase,
    failedAt: Date,
  ): Promise<void> {
    const name = `preview-failure-${session.id}`;
    if (await this.artifacts.getLatest(session.workspaceRef.projectId, name)) return;
    const logs = await this.readDiagnosticLogTail(session);
    const redactedLogs: PreviewLogPage = {
      ...logs,
      entries: logs.entries.map((entry) => ({ ...entry, message: redactString(entry.message) })),
    };
    const diagnostic = PreviewFailureDiagnosticSchema.parse({
      schemaVersion: '1',
      sessionId: session.id,
      projectId: session.workspaceRef.projectId,
      ...(session.runId ? { runId: session.runId } : {}),
      phase,
      health: redactUnknown(session.health),
      restartCount: session.restartCount,
      error: redactUnknown(session.error),
      logs: redactedLogs,
      failedAt: failedAt.toISOString(),
    });
    await this.artifacts.put({
      projectId: session.workspaceRef.projectId,
      name,
      content: diagnostic,
      createdBy: 'preview-service',
      ...(session.runId ? { runId: session.runId } : {}),
      idempotencyKey: createHash('sha256').update(name).digest('hex'),
    });
  }

  private async readDiagnosticLogTail(session: PreviewSession): Promise<PreviewLogPage> {
    let cursor = 0;
    let nextCursor = 0;
    let entries: PreviewLogPage['entries'] = [];
    let omittedBeforeCursor: number | undefined;
    while (true) {
      const page = await this.runner.logs(session, { cursor, limit: DIAGNOSTIC_LOG_LIMIT });
      if (page.truncatedBeforeCursor !== undefined) {
        omittedBeforeCursor = page.truncatedBeforeCursor;
      }
      entries = [...entries, ...page.entries].slice(-DIAGNOSTIC_LOG_LIMIT);
      nextCursor = page.nextCursor;
      if (page.entries.length < DIAGNOSTIC_LOG_LIMIT || nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    const firstCursor = entries[0]?.cursor;
    if (firstCursor !== undefined && firstCursor > 1) omittedBeforeCursor = firstCursor;
    return {
      entries,
      nextCursor: entries.at(-1)?.cursor ?? nextCursor,
      ...(omittedBeforeCursor !== undefined ? { truncatedBeforeCursor: omittedBeforeCursor } : {}),
    };
  }

  private async emit(
    session: PreviewSession,
    type: Extract<ProjectEvent['type'], `preview.${string}`>,
    message: string,
    occurrence: string,
  ): Promise<void> {
    await this.events.append({
      id: this.ids.next(),
      projectId: session.workspaceRef.projectId,
      type,
      createdAt: this.clock.now().toISOString(),
      ...(session.runId ? { runId: session.runId } : {}),
      message,
      dedupeKey: `${session.id}:${type}:${occurrence}`,
      data: { sessionId: session.id, status: session.status, restartCount: session.restartCount },
    });
  }

  private async persist(session: PreviewSession): Promise<PreviewSession> {
    return this.sessions.update(session, session.version);
  }

  private async requireSession(sessionId: string) {
    const record = await this.sessions.get(sessionId);
    if (!record) throw new NotFoundError(`Preview session ${sessionId} not found.`);
    return record;
  }

  private buildUrl(sessionId: string, token: string): string {
    return `${this.config.previewBaseUrl}/${sessionId}/?token=${token}`;
  }

  private async waitForHealthy(session: PreviewSession): Promise<PreviewHealth> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let health: PreviewHealth;
    do {
      health = await this.runner.health(session);
      if (health.state === 'healthy' || Date.now() >= deadline) return health;
      await new Promise((resolveTick) => setTimeout(resolveTick, this.healthIntervalMs));
    } while (Date.now() < deadline);
    return health;
  }

  private stageFailure(session: PreviewSession, failurePhase: PreviewFailurePhase): PreviewSession {
    const { completedAt: _completedAt, ...active } = session;
    return PreviewSessionSchema.parse({
      ...active,
      status: 'failing',
      failurePhase,
      updatedAt: this.clock.now().toISOString(),
    });
  }
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function digestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
