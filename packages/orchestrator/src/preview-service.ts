import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { PreviewHealth, PreviewSession, PreviewWorkspaceRef } from '@agent-foundry/contracts';
import {
  NotFoundError,
  PreviewAccessDeniedError,
  expirePreviewSession,
  isPreviewSessionExpired,
  isPreviewSessionTerminal,
  stopPreviewSession,
  transitionPreviewSession,
  type Clock,
  type IdGenerator,
  type PreviewRunner,
} from '@agent-foundry/domain';

export interface PreviewServiceConfig {
  previewBaseUrl: string;
  ttlSeconds: number;
  startupTimeoutMs?: number;
}

interface StartPreviewInput {
  workspaceRef: PreviewWorkspaceRef;
}

interface ResolvedUpstream {
  port: number;
}

interface TrackedSession {
  session: PreviewSession;
  token: string;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 200;

/** Owns PreviewSession lifecycle orchestration and opaque per-session proxy tokens. In-memory only: durable storage is v05-preview-lifecycle's job. */
export class PreviewService {
  private readonly sessions = new Map<string, TrackedSession>();
  private readonly startupTimeoutMs: number;

  constructor(
    private readonly runner: PreviewRunner,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly config: PreviewServiceConfig,
  ) {
    this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  async start(input: StartPreviewInput): Promise<{ session: PreviewSession; url: string }> {
    const now = this.clock.now();
    let session: PreviewSession = {
      id: this.ids.next(),
      workspaceRef: input.workspaceRef,
      status: 'preparing',
      version: 1,
      health: { state: 'unknown', consecutiveFailures: 0 },
      ttl: { seconds: this.config.ttlSeconds },
      restartCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    session = await this.runner.prepare(session);
    if (isPreviewSessionTerminal(session.status)) {
      this.sessions.set(session.id, { session, token: mintToken() });
      return { session, url: '' };
    }
    session = await this.runner.start(session);
    const token = mintToken();
    this.sessions.set(session.id, { session, token });
    if (isPreviewSessionTerminal(session.status)) {
      // The runner can fail synchronously (e.g. the dev command crashes on
      // spawn) and already transitions to a terminal status itself; skip the
      // health poll and don't try to re-transition an already-terminal session.
      return { session, url: '' };
    }

    const healthy = await this.waitForHealthy(session);
    session = healthy
      ? transitionPreviewSession(session, 'running', this.clock.now(), {
          url: this.buildUrl(session.id, token),
          health: {
            state: 'healthy',
            checkedAt: this.clock.now().toISOString(),
            consecutiveFailures: 0,
          },
        })
      : transitionPreviewSession(session, 'failed', this.clock.now(), {
          error: {
            name: 'PreviewUnhealthyError',
            code: 'PREVIEW_UNHEALTHY',
            message: 'Dev server did not become healthy in time.',
          },
        });
    this.sessions.set(session.id, { session, token });
    return { session, url: session.url ?? '' };
  }

  async stop(sessionId: string): Promise<PreviewSession> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) throw new NotFoundError(`Preview session ${sessionId} not found.`);
    const stopped = stopPreviewSession(await this.runner.stop(tracked.session), this.clock.now());
    this.sessions.set(sessionId, { session: stopped, token: tracked.token }); // token kept for audit, resolveUpstream still denies (terminal status)
    return stopped;
  }

  async resolveUpstream(sessionId: string, token: string | undefined): Promise<ResolvedUpstream> {
    const tracked = this.sessions.get(sessionId);
    if (!tracked) throw new NotFoundError(`Preview session ${sessionId} not found.`);
    let session = tracked.session;
    if (
      !isPreviewSessionTerminal(session.status) &&
      isPreviewSessionExpired(session, this.clock.now())
    ) {
      session = expirePreviewSession(session, this.clock.now());
      this.sessions.set(sessionId, { session, token: tracked.token });
    }
    if (isPreviewSessionTerminal(session.status)) {
      throw new PreviewAccessDeniedError(sessionId, `session is ${session.status}`);
    }
    if (!token || !constantTimeEquals(token, tracked.token)) {
      throw new PreviewAccessDeniedError(sessionId, 'token mismatch');
    }
    if (!session.process?.port) {
      throw new PreviewAccessDeniedError(sessionId, 'session has no upstream port');
    }
    return { port: session.process.port };
  }

  private buildUrl(sessionId: string, token: string): string {
    return `${this.config.previewBaseUrl}/${sessionId}/?token=${token}`;
  }

  private async waitForHealthy(session: PreviewSession): Promise<boolean> {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const health: PreviewHealth = await this.runner.health(session);
      if (health.state === 'healthy') return true;
      await new Promise((resolveTick) => setTimeout(resolveTick, HEALTH_POLL_INTERVAL_MS));
    }
    return false;
  }
}

function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
