import {
  PreviewSessionSchema,
  type PreviewCommandPlan,
  type PreviewHealth,
  type PreviewFailurePhase,
  type PreviewProcess,
  type PreviewSession,
  type PreviewSessionStatus,
  type RunError,
} from '@agent-foundry/contracts';
import { InvalidStateTransitionError } from './errors.js';

const previewSessionTransitions: Record<PreviewSessionStatus, readonly PreviewSessionStatus[]> = {
  preparing: ['starting', 'failing', 'failed', 'stopped'],
  starting: ['running', 'failing', 'failed', 'stopped'],
  running: ['unhealthy', 'failing', 'expired', 'failed', 'stopped'],
  unhealthy: ['running', 'starting', 'failing', 'expired', 'failed', 'stopped'],
  failing: ['failed', 'stopped'],
  stopped: [],
  failed: [],
  expired: [],
};

const terminalStatuses: readonly PreviewSessionStatus[] = ['stopped', 'failed', 'expired'];

export function isPreviewSessionTerminal(status: PreviewSessionStatus): boolean {
  return terminalStatuses.includes(status);
}

export function transitionPreviewSession(
  session: PreviewSession,
  status: PreviewSessionStatus,
  now: Date,
  patch: {
    url?: string;
    process?: PreviewProcess;
    health?: PreviewHealth;
    error?: RunError;
    failurePhase?: PreviewFailurePhase;
  } = {},
): PreviewSession {
  if (!previewSessionTransitions[session.status].includes(status)) {
    throw new InvalidStateTransitionError('preview-session', session.status, status);
  }
  const timestamp = now.toISOString();
  const updated: Record<string, unknown> = { ...session, ...patch, status, updatedAt: timestamp };
  if (status === 'running' && !session.startedAt) {
    updated.startedAt = timestamp;
    updated.ttl = {
      ...session.ttl,
      expiresAt: new Date(now.getTime() + session.ttl.seconds * 1000).toISOString(),
    };
  }
  if (status === 'starting' && session.status !== 'preparing') {
    updated.restartCount = session.restartCount + 1;
  }
  if (isPreviewSessionTerminal(status)) updated.completedAt = timestamp;
  if (status !== 'failed' && status !== 'failing') delete updated.error;
  if (status !== 'failing') delete updated.failurePhase;
  return PreviewSessionSchema.parse(updated);
}

/**
 * Idempotent stop: terminal sessions (stopped, failed, expired) are returned
 * unchanged so cancellation and TTL-expiry paths can always call it safely.
 */
export function stopPreviewSession(session: PreviewSession, now: Date): PreviewSession {
  if (isPreviewSessionTerminal(session.status)) return session;
  return transitionPreviewSession(session, 'stopped', now);
}

export function isPreviewSessionExpired(session: PreviewSession, now: Date): boolean {
  if (isPreviewSessionTerminal(session.status)) return false;
  if (!session.ttl.expiresAt) return false;
  return now.toISOString() >= session.ttl.expiresAt;
}

/** Marks a serving session as expired; the caller must still stop the runner. */
export function expirePreviewSession(session: PreviewSession, now: Date): PreviewSession {
  return transitionPreviewSession(session, 'expired', now);
}

/** Pure update: attaches a detected command plan to the session (e.g. before a runner's prepare()). */
export function recordPreviewCommandPlan(
  session: PreviewSession,
  commandPlan: PreviewCommandPlan,
  now: Date,
): PreviewSession {
  return PreviewSessionSchema.parse({ ...session, commandPlan, updatedAt: now.toISOString() });
}
