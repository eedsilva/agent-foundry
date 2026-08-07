import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserVerificationReport, PreviewLogEntry } from '@agent-foundry/contracts';
import { previewRepairContext, startPreviewLogPolling } from './preview-panel';

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
