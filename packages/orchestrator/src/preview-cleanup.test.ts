import { describe, expect, it, vi } from 'vitest';
import type { PreviewSession, PreviewWorkspaceRef } from '@agent-foundry/contracts';
import { isPreviewSessionTerminal } from '@agent-foundry/domain';
import type { WorkspacePreviewBooter } from './workflow-orchestrator.js';
import { completeRun, makeHarness, makeStores, seedRun } from './testing/harness.js';

const NOW = '2026-08-17T00:00:00.000Z';

/**
 * A stateful preview double, not just a spy: `stop` actually flips the held
 * session to 'stopped' and `activeForProject` stops returning it once
 * terminal, mirroring `PreviewSessionRepository.listActive()` (#579). This
 * lets assertions check the session's own status instead of only call counts.
 */
function makePreviewDouble() {
  let current: PreviewSession | undefined;
  return {
    start: vi.fn(async (input: { workspaceRef: PreviewWorkspaceRef; runId?: string }) => {
      current = {
        id: 'preview-1',
        workspaceRef: input.workspaceRef,
        ...(input.runId ? { runId: input.runId } : {}),
        status: 'running',
        url: 'http://127.0.0.1/preview/preview-1/?token=t',
        version: 1,
        health: { state: 'healthy', checkedAt: NOW, consecutiveFailures: 0 },
        ttl: { seconds: 1_800 },
        restartCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
      };
      return { session: current, url: current.url! };
    }),
    activeForProject: vi.fn(async (projectId: string) =>
      current &&
      current.workspaceRef.projectId === projectId &&
      !isPreviewSessionTerminal(current.status)
        ? current
        : undefined,
    ),
    stop: vi.fn(async (sessionId: string) => {
      if (!current || current.id !== sessionId) {
        throw new Error(`stop() called for unknown session ${sessionId}`);
      }
      current = { ...current, status: 'stopped', completedAt: NOW };
      return current;
    }),
    session: () => current,
    /** Simulates a preview already owned by a different run/project before this run's boot check. */
    seed(session: PreviewSession) {
      current = session;
    },
  } satisfies WorkspacePreviewBooter & {
    session: () => PreviewSession | undefined;
    seed: (session: PreviewSession) => void;
  };
}

describe('preview cleanup on run failure (#579)', () => {
  it('stops the booted preview when the run fails', async () => {
    const previews = makePreviewDouble();
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      makeStores(),
      { previews },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    expect(previews.stop).toHaveBeenCalledExactlyOnceWith('preview-1');
    expect(previews.session()?.status).toBe('stopped');
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
  });

  it('stops the booted preview when the run is cancelled', async () => {
    const previews = makePreviewDouble();
    const harness = makeHarness({ implement: { kind: 'hang-until-abort' } }, makeStores(), {
      previews,
    });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('implement')).toBe(1);
    });
    await harness.service.cancelRun('run-1');
    await running;

    expect((await harness.runs.get('run-1'))?.status).toBe('cancelled');
    expect(previews.stop).toHaveBeenCalledExactlyOnceWith('preview-1');
    expect(previews.session()?.status).toBe('stopped');
  });

  it('stops the booted preview when the run is rejected', async () => {
    const previews = makePreviewDouble();
    const harness = makeHarness({}, makeStores(), { previews, gate: {} });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [approval] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', approval!.request.id, {
      action: 'reject',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('rejected');
    expect(previews.stop).toHaveBeenCalledExactlyOnceWith('preview-1');
    expect(previews.session()?.status).toBe('stopped');
  });

  it('does not stop a preview a second time when a terminal run is restarted (redelivered by the queue)', async () => {
    const previews = makePreviewDouble();
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      makeStores(),
      { previews },
    );
    await seedRun(harness);
    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();
    expect(previews.stop).toHaveBeenCalledExactlyOnceWith('preview-1');

    // Redeliver the already-terminal run (e.g. a queue retry after the earlier throw).
    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).resolves.toBeUndefined();

    expect(previews.stop).toHaveBeenCalledExactlyOnceWith('preview-1');
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
  });

  it('leaves a preview booted by a different run alone', async () => {
    const previews = makePreviewDouble();
    previews.seed({
      id: 'preview-other',
      workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/ws' },
      runId: 'run-other',
      status: 'running',
      version: 1,
      health: { state: 'healthy', checkedAt: NOW, consecutiveFailures: 0 },
      ttl: { seconds: 1_800 },
      restartCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      makeStores(),
      { previews },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    // The project already had a live session, so this run never booted its own.
    expect(previews.start).not.toHaveBeenCalled();
    expect(previews.stop).not.toHaveBeenCalled();
    expect(previews.session()).toMatchObject({ id: 'preview-other', status: 'running' });
  });

  it('leaves a pre-existing preview without run ownership alone', async () => {
    const previews = makePreviewDouble();
    previews.seed({
      id: 'preview-manual',
      workspaceRef: { projectId: 'project-1', workspacePath: '/tmp/ws' },
      status: 'running',
      version: 1,
      health: { state: 'healthy', checkedAt: NOW, consecutiveFailures: 0 },
      ttl: { seconds: 1_800 },
      restartCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      makeStores(),
      { previews },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    expect(previews.start).not.toHaveBeenCalled();
    expect(previews.stop).not.toHaveBeenCalled();
    expect(previews.session()).toMatchObject({ id: 'preview-manual', status: 'running' });
  });

  it('keeps the preview running when the run completes', async () => {
    const previews = makePreviewDouble();
    const harness = makeHarness({}, makeStores(), { previews });

    await completeRun(harness);

    expect(previews.stop).not.toHaveBeenCalled();
    expect(previews.session()?.status).toBe('running');
  });

  it('does not let a cleanup failure mask the run failure or its terminal status', async () => {
    const previews = makePreviewDouble();
    previews.stop.mockImplementation(async () => {
      throw new Error('preview lifecycle lock unavailable');
    });
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      makeStores(),
      { previews },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    // Pins that cleanup was actually attempted (and its throw swallowed), not
    // just that the run's own failure survived a cleanup call that never happened.
    expect(previews.stop).toHaveBeenCalledWith('preview-1');
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(harness.events.events).toContainEqual(
      expect.objectContaining({
        type: 'preview.cleanup_failed',
        runId: 'run-1',
        dedupeKey: 'run-1:preview.cleanup_failed',
        data: {
          sessionId: 'preview-1',
          error: 'preview lifecycle lock unavailable',
        },
      }),
    );
  });
});
