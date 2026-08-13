import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserVerificationReport,
  PreviewLogEntry,
  PreviewSession,
} from '@agent-foundry/contracts';
import {
  pinnedPreviewUrl,
  previewRepairContext,
  previewStatusMessage,
  startPreviewLogPolling,
  startPreviewSessionPolling,
} from './preview-panel';

afterEach(() => vi.useRealTimers());

describe('startPreviewLogPolling', () => {
  it('schedules the next log poll after one failed page fetch', async () => {
    vi.useFakeTimers();
    const getPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({
        entries: [
          {
            cursor: 1,
            stream: 'stdout',
            message: 'resumed',
            timestamp: '2026-07-23T00:00:00.000Z',
          },
        ],
        nextCursor: 1,
      });
    const received: PreviewLogEntry[] = [];

    const stop = startPreviewLogPolling({
      getPage,
      onEntries: (entries) => received.push(...entries),
      onError: () => undefined,
      schedule: (callback) => setTimeout(callback, 2_000),
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getPage).toHaveBeenCalledTimes(2);
    expect(received.map((entry) => entry.message)).toEqual(['resumed']);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});

function runningSession(overrides: Partial<PreviewSession> = {}): PreviewSession {
  return {
    id: 'preview-1',
    workspaceRef: { projectId: 'p1', ref: 'main' },
    status: 'running',
    version: 1,
    url: 'http://127.0.0.1:4000/preview/preview-1/?token=abc',
    process: { pid: 1, port: 65000 },
    health: { state: 'healthy', consecutiveFailures: 0 },
    ttl: { seconds: 1800, expiresAt: '2026-07-23T00:30:00.000Z' },
    restartCount: 0,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
    startedAt: '2026-07-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('startPreviewSessionPolling', () => {
  it('re-fetches the session on a timer, surfacing a status change the caller never asked for', async () => {
    vi.useFakeTimers();
    const stale = runningSession();
    const expired = runningSession({ status: 'expired', url: undefined, process: undefined });
    const getSession = vi
      .fn()
      .mockResolvedValueOnce({ session: stale })
      .mockResolvedValueOnce({ session: expired });
    const received: (PreviewSession | null)[] = [];

    const stop = startPreviewSessionPolling({
      getSession,
      onSession: (session) => received.push(session),
      onError: () => undefined,
      schedule: (callback) => setTimeout(callback, 2_000),
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(received.map((session) => session?.status)).toEqual(['running', 'expired']);
    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('keeps polling on a page fetch error, matching startPreviewLogPolling', async () => {
    vi.useFakeTimers();
    const getSession = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ session: runningSession() });
    const errors: unknown[] = [];

    const stop = startPreviewSessionPolling({
      getSession,
      onSession: () => undefined,
      onError: (cause) => errors.push(cause),
      schedule: (callback) => setTimeout(callback, 2_000),
    });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(getSession).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    stop();
  });
});

describe('previewStatusMessage', () => {
  it('only clears the iframe to render for a running session with a url', () => {
    expect(previewStatusMessage(runningSession())).toBeNull();
  });

  it('names the transient states resolveUpstream would still deny', () => {
    expect(previewStatusMessage(runningSession({ status: 'preparing' }))).toMatch(/iniciando/i);
    expect(previewStatusMessage(runningSession({ status: 'starting' }))).toMatch(/iniciando/i);
    expect(previewStatusMessage(runningSession({ status: 'unhealthy' }))).toMatch(/instável/i);
  });

  it("does not claim a retry is coming for 'failing' — restarts are already exhausted by then", () => {
    // preview-service.ts only transitions to 'failing' once restartCount >= maxRestarts,
    // finalizing to terminal 'failed' next; no further restart attempt happens.
    const message = previewStatusMessage(runningSession({ status: 'failing' }));
    expect(message).not.toMatch(/tentando novamente/i);
    expect(message).toMatch(/falha/i);
  });

  it('treats a running session with no url yet as still starting, not embeddable', () => {
    expect(previewStatusMessage(runningSession({ url: undefined }))).toMatch(/iniciando/i);
  });

  it('does not blank an already-shown iframe for a transient unhealthy blip (#510 CI regression)', () => {
    // preview-service.ts's health-check loop can flap a session to 'unhealthy'
    // and back to 'running' under load without anything actually being wrong —
    // see the transition table in packages/domain/src/preview-state.ts, where
    // 'unhealthy' -> 'running' is a legal, expected transition. Once the panel
    // has successfully shown a session's iframe, a poll observing that same
    // session as merely 'unhealthy' must not hide it again: doing so remounts
    // the iframe on the next poll, discarding any in-page state (a real CI
    // failure in golden-flow.spec.ts's visual-edit test, which manually
    // navigates the iframe's inner frame and expects that to survive several
    // seconds of UI interaction — long enough to cross multiple 2s polls).
    const unhealthy = runningSession({ status: 'unhealthy' });
    expect(previewStatusMessage(unhealthy, true)).toBeNull();
  });

  it('still blanks an unhealthy session that has never successfully shown yet', () => {
    const unhealthy = runningSession({ status: 'unhealthy' });
    expect(previewStatusMessage(unhealthy, false)).toMatch(/instável/i);
  });

  it("does not extend the 'already shown' grace to failing — it never recovers to running", () => {
    const failing = runningSession({ status: 'failing' });
    expect(previewStatusMessage(failing, true)).not.toBeNull();
  });

  it('does not blank an already-shown iframe while a restart respawns the process (starting)', () => {
    // packages/domain/src/preview-state.ts's transition table: 'unhealthy' can
    // go to 'starting' (node-preview-runner.ts's restart() -> spawn()
    // transitions there), not straight back to 'running' — the health-check
    // restart path in preview-service.ts genuinely passes through 'starting'
    // before the respawned process is confirmed healthy again. The prior fix
    // for the #510 CI regression only granted the already-shown grace to
    // 'unhealthy', so a poll landing during this 'starting' leg still blanked
    // (and on the next poll, remounted) an iframe that was already showing
    // good content mid-interaction.
    const starting = runningSession({ status: 'starting' });
    expect(previewStatusMessage(starting, true)).toBeNull();
  });
});

describe('pinnedPreviewUrl', () => {
  it('uses the session url the first time a session is shown', () => {
    const session = runningSession();
    expect(pinnedPreviewUrl(session, undefined)).toBe(session.url);
  });

  it('keeps the first-shown url for the same session even after a later poll strips it (#486)', () => {
    // packages/persistence's sanitizeSession strips ?token= from a preview
    // session's url on every read after the initial start() response — a
    // deliberate, tested security property: the raw token must never be
    // re-servable from disk (see preview-repositories.test.ts). The 2s
    // session-status poll (#510) can only ever observe that stripped url for
    // an already-running session; feeding it straight to the iframe's src
    // forces a reload the proxy then denies as a raw token-mismatch 403.
    const session = runningSession();
    const polledLater = runningSession({
      url: 'http://127.0.0.1:4000/preview/preview-1/',
    });
    const shown = { sessionId: session.id, url: session.url! };
    expect(pinnedPreviewUrl(polledLater, shown)).toBe(session.url);
  });

  it('adopts the new url for a newly started session rather than the previous one', () => {
    const shown = {
      sessionId: 'preview-0',
      url: 'http://127.0.0.1:4000/preview/preview-0/?token=old',
    };
    const session = runningSession();
    expect(pinnedPreviewUrl(session, shown)).toBe(session.url);
  });
});

describe('previewRepairContext', () => {
  it('turns passive console and request failures into one repair prompt', () => {
    const report: BrowserVerificationReport = {
      schemaVersion: '1',
      approved: false,
      summary: '1 browser step failure(s) and 1 passive failure(s).',
      planArtifact: { name: 'browser-plan', revision: 1, sha256: 'a'.repeat(64) },
      previewSession: { sessionId: 'preview-1', status: 'running', evidence: { screenshots: [] } },
      steps: [
        {
          stepId: 'step-1',
          title: 'Open the app',
          status: 'failed',
          durationMs: 1,
          error: 'Passive browser failure observed.',
          observations: [
            { kind: 'console-error', message: 'ReferenceError: broken' },
            { kind: 'request-failed', message: 'net::ERR_FAILED' },
          ],
        },
      ],
    };

    const failure = previewRepairContext(null, [], report);

    expect(failure).toMatchObject({
      key: 'preview-1:1 browser step failure(s) and 1 passive failure(s).',
      title: 'Preview verification failure',
    });
    expect(failure?.detail).toContain('ReferenceError: broken');
    expect(failure?.detail).toContain('net::ERR_FAILED');
  });

  it('surfaces a redacted runtime log failure while the preview is still running', () => {
    const failure = previewRepairContext(null, [], null, [
      {
        cursor: 1,
        stream: 'stderr',
        message: 'ReferenceError: broken runtime',
        timestamp: '2026-07-23T00:00:00.000Z',
      },
    ]);

    expect(failure).toMatchObject({ title: 'Preview runtime error' });
    expect(failure?.detail).toContain('ReferenceError: broken runtime');
  });

  it('ignores a failure event from an older preview session', () => {
    const failure = previewRepairContext(
      {
        id: 'preview-2',
        workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/project-1' },
        status: 'running',
        version: 1,
        url: 'http://localhost:4000/preview/preview-2/',
        process: { pid: 1, command: 'npm', args: [] },
        health: { state: 'healthy', consecutiveFailures: 0 },
        ttl: { seconds: 1800 },
        restartCount: 0,
        createdAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
        startedAt: '2026-07-23T00:00:00.000Z',
      },
      [
        {
          id: 'preview-event-1',
          projectId: 'project-1',
          type: 'preview.failed',
          createdAt: '2026-07-22T00:00:00.000Z',
          message: 'Old preview failed.',
          data: {
            diagnostic: {
              schemaVersion: '1',
              sessionId: 'preview-1',
              projectId: 'project-1',
              phase: 'runtime',
              health: { state: 'failed', consecutiveFailures: 1 },
              restartCount: 0,
              error: { name: 'Error', message: 'old failure' },
              logs: { entries: [], nextCursor: 0 },
              output: { stdout: '', stderr: '' },
              failedAt: '2026-07-22T00:00:00.000Z',
            },
          },
        },
      ],
      null,
      [
        {
          cursor: 1,
          stream: 'stderr',
          message: 'ReferenceError: new runtime failure',
          timestamp: '2026-07-23T00:00:00.000Z',
        },
      ],
    );

    expect(failure).toMatchObject({ title: 'Preview runtime error' });
    expect(failure?.detail).toContain('new runtime failure');
  });
});
