import { describe, expect, it } from 'vitest';
import type { PreviewCommandPlan, PreviewHealth, PreviewSession } from '@agent-foundry/contracts';
import { InvalidStateTransitionError } from './errors.js';
import type { PreviewRunner } from './ports.js';
import {
  expirePreviewSession,
  isPreviewSessionExpired,
  isPreviewSessionTerminal,
  recordPreviewCommandPlan,
  stopPreviewSession,
  transitionPreviewSession,
} from './preview-state.js';

class FakeClock {
  constructor(private current = new Date('2026-07-14T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

function newSession(ttlSeconds = 1800): PreviewSession {
  const timestamp = '2026-07-14T12:00:00.000Z';
  return {
    id: 'preview-1',
    runId: 'run-1',
    workspaceRef: { projectId: 'project-1', workspacePath: '/workspace' },
    status: 'preparing',
    version: 1,
    health: { state: 'unknown', consecutiveFailures: 0 },
    ttl: { seconds: ttlSeconds },
    restartCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * In-memory runner used to exercise the port contract: startup, unhealthy
 * probes, restart, start timeout, and idempotent stop. No real processes.
 */
class FakePreviewRunner implements PreviewRunner {
  private healthyAfterProbes: number;

  constructor(
    private readonly clock: FakeClock,
    private readonly options: {
      startupSeconds?: number;
      startTimeoutSeconds?: number;
      unhealthyProbes?: number;
    } = {},
  ) {
    this.healthyAfterProbes = options.unhealthyProbes ?? 0;
  }

  prepare(session: PreviewSession): Promise<PreviewSession> {
    return Promise.resolve(transitionPreviewSession(session, 'starting', this.clock.now()));
  }

  start(session: PreviewSession): Promise<PreviewSession> {
    const startupSeconds = this.options.startupSeconds ?? 1;
    const timeoutSeconds = this.options.startTimeoutSeconds ?? 30;
    this.clock.advanceSeconds(startupSeconds);
    if (startupSeconds > timeoutSeconds) {
      return Promise.resolve(
        transitionPreviewSession(session, 'failed', this.clock.now(), {
          error: {
            name: 'PreviewStartTimeout',
            message: `dev server did not bind within ${timeoutSeconds}s`,
          },
        }),
      );
    }
    return Promise.resolve(
      transitionPreviewSession(session, 'running', this.clock.now(), {
        url: 'http://127.0.0.1:3100',
        process: { command: 'pnpm', args: ['dev'], pid: 4321, port: 3100 },
        health: {
          state: 'healthy',
          checkedAt: this.clock.now().toISOString(),
          consecutiveFailures: 0,
        },
      }),
    );
  }

  health(session: PreviewSession): Promise<PreviewHealth> {
    if (this.healthyAfterProbes > 0) {
      this.healthyAfterProbes -= 1;
      return Promise.resolve({
        state: 'unhealthy',
        checkedAt: this.clock.now().toISOString(),
        detail: 'HTTP 500 from /',
        consecutiveFailures: session.health.consecutiveFailures + 1,
      });
    }
    return Promise.resolve({
      state: 'healthy',
      checkedAt: this.clock.now().toISOString(),
      consecutiveFailures: 0,
    });
  }

  logs(): Promise<string> {
    return Promise.resolve('ready - started server on 127.0.0.1:3100\n');
  }

  async restart(session: PreviewSession): Promise<PreviewSession> {
    const restarting = transitionPreviewSession(session, 'starting', this.clock.now());
    return this.start(restarting);
  }

  stop(session: PreviewSession): Promise<PreviewSession> {
    return Promise.resolve(stopPreviewSession(session, this.clock.now()));
  }
}

describe('preview session state machine', () => {
  it('walks the happy startup path preparing -> starting -> running', async () => {
    const clock = new FakeClock();
    const runner = new FakePreviewRunner(clock);
    const started = await runner.start(await runner.prepare(newSession()));
    expect(started.status).toBe('running');
    expect(started.url).toBe('http://127.0.0.1:3100');
    expect(started.startedAt).toBeDefined();
    expect(started.ttl.expiresAt).toBe('2026-07-14T12:30:01.000Z');
    expect(started.restartCount).toBe(0);
  });

  it('marks a session unhealthy from probes and recovers through restart', async () => {
    const clock = new FakeClock();
    const runner = new FakePreviewRunner(clock, { unhealthyProbes: 1 });
    let session = await runner.start(await runner.prepare(newSession()));

    const probe = await runner.health(session);
    expect(probe.state).toBe('unhealthy');
    session = transitionPreviewSession(session, 'unhealthy', clock.now(), { health: probe });
    expect(session.status).toBe('unhealthy');
    expect(session.health.consecutiveFailures).toBe(1);

    session = await runner.restart(session);
    expect(session.status).toBe('running');
    expect(session.restartCount).toBe(1);
    expect((await runner.health(session)).state).toBe('healthy');
  });

  it('fails the session when startup exceeds the timeout', async () => {
    const clock = new FakeClock();
    const runner = new FakePreviewRunner(clock, { startupSeconds: 45, startTimeoutSeconds: 30 });
    const failed = await runner.start(await runner.prepare(newSession()));
    expect(failed.status).toBe('failed');
    expect(failed.error?.name).toBe('PreviewStartTimeout');
    expect(failed.completedAt).toBeDefined();
    expect(isPreviewSessionTerminal(failed.status)).toBe(true);
  });

  it('expires a running session after its TTL and stop stays idempotent', async () => {
    const clock = new FakeClock();
    const runner = new FakePreviewRunner(clock);
    const running = await runner.start(await runner.prepare(newSession(60)));

    expect(isPreviewSessionExpired(running, clock.now())).toBe(false);
    clock.advanceSeconds(61);
    expect(isPreviewSessionExpired(running, clock.now())).toBe(true);

    const expired = expirePreviewSession(running, clock.now());
    expect(expired.status).toBe('expired');

    const stoppedOnce = await runner.stop(expired);
    const stoppedTwice = await runner.stop(stoppedOnce);
    expect(stoppedOnce).toBe(expired);
    expect(stoppedTwice).toBe(stoppedOnce);
    expect(isPreviewSessionExpired(expired, clock.now())).toBe(false);
  });

  it('stops a live session on cancellation and repeated stops are no-ops', async () => {
    const clock = new FakeClock();
    const runner = new FakePreviewRunner(clock);
    const running = await runner.start(await runner.prepare(newSession()));

    const stopped = await runner.stop(running);
    expect(stopped.status).toBe('stopped');
    expect(stopped.completedAt).toBeDefined();
    expect(await runner.stop(stopped)).toBe(stopped);
  });

  it('rejects invalid transitions', () => {
    const clock = new FakeClock();
    expect(() => transitionPreviewSession(newSession(), 'unhealthy', clock.now())).toThrow(
      InvalidStateTransitionError,
    );
    const stopped = stopPreviewSession(newSession(), clock.now());
    expect(() => transitionPreviewSession(stopped, 'starting', clock.now())).toThrow(
      InvalidStateTransitionError,
    );
  });
});

describe('recordPreviewCommandPlan', () => {
  it('records a command plan on the session and bumps updatedAt', () => {
    const session = newSession();
    const plan: PreviewCommandPlan = {
      packageManager: 'npm',
      install: { ok: true, command: 'npm', args: ['ci'] },
      build: { ok: true, command: 'npm', args: ['run', 'build'] },
      dev: { ok: true, command: 'npm', args: ['run', 'dev'] },
      detectedAt: '2026-07-16T00:00:00.000Z',
    };

    const updated = recordPreviewCommandPlan(session, plan, new Date('2026-07-16T00:00:01.000Z'));

    expect(updated.commandPlan).toEqual(plan);
    expect(updated.updatedAt).toBe('2026-07-16T00:00:01.000Z');
  });
});
