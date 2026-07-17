import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PreviewFailureDiagnosticSchema,
  type PreviewFailureDiagnostic,
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
  transitionPreviewSession,
  type ArtifactStore,
  type Clock,
  type EventStore,
  type IdGenerator,
  type PreviewRunner,
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
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: PreviewRunner,
    private readonly sessions: PreviewSessionRepository,
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
    return this.withSessionLock(sessionId, async () => {
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

      session = await this.runner.prepare(session);
      if (isPreviewSessionTerminal(session.status)) {
        session = await this.finalizeFailure(session, 'prepare');
        return { session, url: '' };
      }
      session = await this.persist(session);

      session = await this.runner.start(session);
      if (isPreviewSessionTerminal(session.status)) {
        session = await this.finalizeFailure(session, 'start');
        return { session, url: '' };
      }
      session = await this.persist(session);

      const health = await this.waitForHealthy(session);
      if (health.state !== 'healthy') {
        const failed = transitionPreviewSession(session, 'failed', this.clock.now(), {
          health,
          error: {
            name: 'PreviewUnhealthyError',
            code: 'PREVIEW_UNHEALTHY',
            message: 'Dev server did not become healthy in time.',
          },
        });
        session = await this.finalizeFailure(failed, 'health');
        return { session, url: '' };
      }

      const url = this.buildUrl(session.id, token);
      const running = transitionPreviewSession(session, 'running', this.clock.now(), {
        url,
        health: { ...health, consecutiveFailures: 0 },
      });
      session = await this.persist(running);
      return { session: { ...session, url }, url };
    });
  }

  async stop(sessionId: string): Promise<PreviewSession> {
    return this.withSessionLock(sessionId, async () => {
      const record = await this.requireSession(sessionId);
      if (isPreviewSessionTerminal(record.session.status)) return record.session;
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
    return this.withSessionLock(sessionId, async () => {
      const record = await this.requireSession(sessionId);
      let session = record.session;
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
    for (const record of active) {
      reaped += await this.withSessionLock(record.session.id, async () =>
        this.reapSession(record.session.id),
      );
    }
    return reaped;
  }

  private async reapSession(sessionId: string): Promise<number> {
    const record = await this.sessions.get(sessionId);
    if (!record || isPreviewSessionTerminal(record.session.status)) return 0;
    let session = record.session;

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
      await this.runner.stop(session);
      const failed = transitionPreviewSession(session, 'failed', this.clock.now(), {
        health,
        error: {
          name: 'PreviewCrashLoopError',
          code: 'PREVIEW_RESTART_LIMIT',
          message: `Preview restart limit of ${this.maxRestarts} reached.`,
        },
      });
      await this.finalizeFailure(failed, 'runtime', true);
      return 1;
    }

    session = await this.runner.restart(session);
    if (isPreviewSessionTerminal(session.status)) {
      await this.finalizeFailure(session, 'runtime');
      return 1;
    }
    session = await this.persist(session);
    const restartedHealth = await this.waitForHealthy(session);
    if (restartedHealth.state !== 'healthy') {
      const failed = transitionPreviewSession(session, 'failed', this.clock.now(), {
        health: restartedHealth,
        error: {
          name: 'PreviewUnhealthyError',
          code: 'PREVIEW_UNHEALTHY',
          message: 'Restarted dev server did not become healthy in time.',
        },
      });
      await this.finalizeFailure(failed, 'health');
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

  private async finalizeFailure(
    failed: PreviewSession,
    phase: PreviewFailureDiagnostic['phase'],
    alreadyStopped = false,
  ): Promise<PreviewSession> {
    if (!alreadyStopped) await this.runner.stop(failed);
    const session = await this.persist(failed);
    await this.emit(
      session,
      'preview.failed',
      session.error?.message ?? 'preview failed',
      'terminal',
    );
    await this.writeFailureDiagnostic(session, phase);
    return session;
  }

  private async writeFailureDiagnostic(
    session: PreviewSession,
    phase: PreviewFailureDiagnostic['phase'],
  ): Promise<void> {
    const name = `preview-failure-${session.id}`;
    if (await this.artifacts.getLatest(session.workspaceRef.projectId, name)) return;
    const logs = await this.runner.logs(session, { limit: DIAGNOSTIC_LOG_LIMIT });
    const diagnostic = PreviewFailureDiagnosticSchema.parse({
      schemaVersion: '1',
      sessionId: session.id,
      projectId: session.workspaceRef.projectId,
      ...(session.runId ? { runId: session.runId } : {}),
      phase,
      health: session.health,
      restartCount: session.restartCount,
      error: session.error,
      logs,
      failedAt: session.completedAt,
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

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.locks.set(sessionId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    }
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
