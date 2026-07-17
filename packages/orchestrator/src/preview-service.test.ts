import { describe, expect, it } from 'vitest';
import type { PreviewHealth, PreviewSession } from '@agent-foundry/contracts';
import {
  PreviewAccessDeniedError,
  type PreviewRunner,
  type Clock,
  type IdGenerator,
} from '@agent-foundry/domain';
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
    return `sess-${this.n}`;
  }
}

class InMemoryPreviewRunner implements PreviewRunner {
  async prepare(session: PreviewSession): Promise<PreviewSession> {
    return session;
  }
  async start(session: PreviewSession): Promise<PreviewSession> {
    return {
      ...session,
      status: 'starting',
      process: { command: 'node', args: [], port: 4100 },
      updatedAt: new Date().toISOString(),
    };
  }
  async health(): Promise<PreviewHealth> {
    return { state: 'healthy', consecutiveFailures: 0 };
  }
  async logs(): Promise<string> {
    return '';
  }
  async restart(session: PreviewSession): Promise<PreviewSession> {
    return session;
  }
  async stop(session: PreviewSession): Promise<PreviewSession> {
    return {
      ...session,
      status: 'stopped',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

/** Never reports healthy, to exercise the start() failed-startup path deterministically. */
class NeverHealthyPreviewRunner extends InMemoryPreviewRunner {
  override async health(): Promise<PreviewHealth> {
    return { state: 'unhealthy', consecutiveFailures: 1 };
  }
}

/** Crashes synchronously, like NodePreviewRunner does when the dev command exits immediately. */
class CrashesOnStartPreviewRunner extends InMemoryPreviewRunner {
  override async start(session: PreviewSession): Promise<PreviewSession> {
    return {
      ...session,
      status: 'failed',
      error: { name: 'PreviewStartError', code: 'PREVIEW_START_FAILED', message: 'boom' },
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
}

function buildService(
  clock: FixedClock = new FixedClock(new Date('2026-01-01T00:00:00.000Z')),
  configOverrides: Partial<PreviewServiceConfig> = {},
  runner: PreviewRunner = new InMemoryPreviewRunner(),
) {
  const service = new PreviewService(runner, clock, new SequentialIds(), {
    previewBaseUrl: 'http://127.0.0.1:4000/preview',
    ttlSeconds: 60,
    ...configOverrides,
  });
  return { service, clock };
}

describe('PreviewService', () => {
  it('starts a session, mints a token, and exposes a proxy url without the internal port', async () => {
    const { service } = buildService();
    const { session, url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    expect(session.status).toBe('running');
    expect(url).toContain('/preview/sess-1');
    expect(url).not.toContain('4100');
    expect(session.url).toBe(url);
  });

  it('resolveUpstream accepts the token minted at start and returns the internal port', async () => {
    const { service } = buildService();
    const { url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    const token = new URL(url).searchParams.get('token')!;
    const resolved = await service.resolveUpstream('sess-1', token);
    expect(resolved.port).toBe(4100);
  });

  it('resolveUpstream rejects a wrong token', async () => {
    const { service } = buildService();
    await service.start({ workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' } });
    await expect(service.resolveUpstream('sess-1', 'not-the-token')).rejects.toBeInstanceOf(
      PreviewAccessDeniedError,
    );
  });

  it('resolveUpstream rejects after stop', async () => {
    const { service } = buildService();
    const { url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    const token = new URL(url).searchParams.get('token')!;
    await service.stop('sess-1');
    await expect(service.resolveUpstream('sess-1', token)).rejects.toBeInstanceOf(
      PreviewAccessDeniedError,
    );
  });

  it('resolveUpstream rejects once the TTL has elapsed', async () => {
    const { service, clock } = buildService();
    const { url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    const token = new URL(url).searchParams.get('token')!;
    clock.advance(61_000);
    await expect(service.resolveUpstream('sess-1', token)).rejects.toBeInstanceOf(
      PreviewAccessDeniedError,
    );
  });

  // Regression test for a bug in the original plan: transitioning to 'failed' here
  // attached a RunError without the schema-required `name` field, which throws a
  // ZodError the instant a preview fails to become healthy in time. startupTimeoutMs: 0
  // starves waitForHealthy of any budget so this resolves deterministically with no
  // real setTimeout wait.
  it('marks the session failed instead of throwing when the preview never becomes healthy in time', async () => {
    const { service } = buildService(
      undefined,
      { startupTimeoutMs: 0 },
      new NeverHealthyPreviewRunner(),
    );
    const { session, url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    expect(session.status).toBe('failed');
    expect(session.error?.name).toBe('PreviewUnhealthyError');
    expect(url).toBe('');
  });

  // Regression test found via a real NodePreviewRunner integration test (Task 6): when a dev
  // command crashes on spawn, runner.start() already returns a terminal ('failed') session.
  // start() used to keep going into waitForHealthy() and then try to transition
  // failed -> failed, which threw InvalidStateTransitionError instead of surfacing the failure.
  it('returns the failed session as-is when the runner fails synchronously in start()', async () => {
    const { service } = buildService(undefined, {}, new CrashesOnStartPreviewRunner());
    const { session, url } = await service.start({
      workspaceRef: { projectId: 'proj-1', workspacePath: '/tmp/proj-1' },
    });
    expect(session.status).toBe('failed');
    expect(session.error?.code).toBe('PREVIEW_START_FAILED');
    expect(url).toBe('');
  });
});
