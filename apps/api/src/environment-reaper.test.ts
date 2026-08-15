import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment, WorkflowRun } from '@agent-foundry/contracts';
import type { PreviewSessionRecord } from '@agent-foundry/domain';
import { sweepIdleEnvironments, type EnvironmentReaperDeps } from './environment-reaper.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');
const IDLE_MS = 30 * 60 * 1000;

function environment(overrides: Partial<AppEnvironment> = {}): AppEnvironment {
  return {
    projectId: 'proj-1',
    composeProjectName: 'foundry-proj-1',
    workdir: '/tmp/proj-1',
    network: 'foundry-proj-1',
    volumes: ['foundry-proj-1-db'],
    ports: { api: 54321 },
    endpoints: { api: 'http://127.0.0.1:54321' },
    health: { state: 'healthy', checkedAt: '2026-08-14T10:00:00.000Z' },
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    projectId: 'proj-1',
    status: 'completed',
    ...overrides,
  } as WorkflowRun;
}

function previewSession(projectId: string): PreviewSessionRecord {
  return {
    session: { workspaceRef: { projectId } },
    tokenDigest: 'digest',
  } as PreviewSessionRecord;
}

function makeDeps(overrides: {
  environments?: AppEnvironment[];
  activeSessions?: PreviewSessionRecord[];
  runsByProject?: Record<string, WorkflowRun[]>;
  stop?: ReturnType<typeof vi.fn>;
}): EnvironmentReaperDeps & {
  listEnvironments: ReturnType<typeof vi.fn>;
  listActive: ReturnType<typeof vi.fn>;
  listRuns: ReturnType<typeof vi.fn>;
  stopMock: ReturnType<typeof vi.fn>;
} {
  const listEnvironments = vi.fn().mockResolvedValue(overrides.environments ?? [environment()]);
  const listActive = vi.fn().mockResolvedValue(overrides.activeSessions ?? []);
  const runsByProject = overrides.runsByProject ?? {};
  const listRuns = vi.fn((projectId: string) => Promise.resolve(runsByProject[projectId] ?? []));
  const stopMock = overrides.stop ?? vi.fn().mockResolvedValue(environment());

  return {
    environments: { listEnvironments, stop: stopMock },
    previewSessions: { listActive },
    runs: { list: listRuns },
    listEnvironments,
    listActive,
    listRuns,
    stopMock,
  };
}

const logger = () => ({ info: vi.fn(), error: vi.fn() });

describe('sweepIdleEnvironments', () => {
  it('stops an idle environment', async () => {
    const env = environment({ updatedAt: '2026-08-14T11:00:00.000Z' }); // 1h idle
    const deps = makeDeps({ environments: [env] });
    const log = logger();

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, log);

    expect(count).toBe(1);
    expect(deps.stopMock).toHaveBeenCalledWith('proj-1');
    expect(log.info).toHaveBeenCalledWith({ projectId: 'proj-1' }, expect.any(String));
    expect(deps.listRuns).toHaveBeenCalledWith('proj-1', expect.any(Number));
  });

  it('stops an environment exactly idleMs old (boundary is inclusive)', async () => {
    const env = environment({ updatedAt: new Date(NOW.getTime() - IDLE_MS).toISOString() });
    const deps = makeDeps({ environments: [env] });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(1);
    expect(deps.stopMock).toHaveBeenCalledWith('proj-1');
  });

  it('does not stop an environment with an unparseable updatedAt (fails closed)', async () => {
    const env = environment({ updatedAt: 'not-a-date' });
    const deps = makeDeps({ environments: [env] });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(0);
    expect(deps.stopMock).not.toHaveBeenCalled();
  });

  it('does not stop an environment younger than idleMs', async () => {
    const env = environment({ updatedAt: '2026-08-14T11:55:00.000Z' }); // 5min idle
    const deps = makeDeps({ environments: [env] });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(0);
    expect(deps.stopMock).not.toHaveBeenCalled();
  });

  it('does not stop an already-stopped environment', async () => {
    const env = environment({
      updatedAt: '2026-08-14T09:00:00.000Z',
      health: { state: 'stopped', checkedAt: '2026-08-14T09:00:00.000Z' },
    });
    const deps = makeDeps({ environments: [env] });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(0);
    expect(deps.stopMock).not.toHaveBeenCalled();
  });

  it('does not stop an environment whose project has an active preview session', async () => {
    const env = environment({ updatedAt: '2026-08-14T09:00:00.000Z' });
    const deps = makeDeps({
      environments: [env],
      activeSessions: [previewSession('proj-1')],
    });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(0);
    expect(deps.stopMock).not.toHaveBeenCalled();
  });

  it('does not stop an environment whose project has a non-terminal run, but does when the only run is completed', async () => {
    const runningEnv = environment({
      projectId: 'proj-running',
      updatedAt: '2026-08-14T09:00:00.000Z',
    });
    const completedEnv = environment({
      projectId: 'proj-completed',
      updatedAt: '2026-08-14T09:00:00.000Z',
    });
    const deps = makeDeps({
      environments: [runningEnv, completedEnv],
      runsByProject: {
        'proj-running': [workflowRun({ projectId: 'proj-running', status: 'running' })],
        'proj-completed': [workflowRun({ projectId: 'proj-completed', status: 'completed' })],
      },
    });

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(count).toBe(1);
    expect(deps.stopMock).toHaveBeenCalledTimes(1);
    expect(deps.stopMock).toHaveBeenCalledWith('proj-completed');
  });

  it('logs and continues past a failing stop(), returning the surviving count', async () => {
    const failing = environment({ projectId: 'proj-fail', updatedAt: '2026-08-14T09:00:00.000Z' });
    const ok = environment({ projectId: 'proj-ok', updatedAt: '2026-08-14T09:00:00.000Z' });
    const stopMock = vi.fn((projectId: string) =>
      projectId === 'proj-fail'
        ? Promise.reject(new Error('docker down'))
        : Promise.resolve(environment({ projectId })),
    );
    const deps = makeDeps({ environments: [failing, ok], stop: stopMock });
    const log = logger();

    const count = await sweepIdleEnvironments(deps, IDLE_MS, NOW, log);

    expect(count).toBe(1);
    expect(stopMock).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(expect.any(Error), expect.any(String));
  });

  it('calls listActive() once per sweep regardless of environment count', async () => {
    const envs = [
      environment({ projectId: 'proj-a', updatedAt: '2026-08-14T09:00:00.000Z' }),
      environment({ projectId: 'proj-b', updatedAt: '2026-08-14T09:00:00.000Z' }),
      environment({ projectId: 'proj-c', updatedAt: '2026-08-14T09:00:00.000Z' }),
    ];
    const deps = makeDeps({ environments: envs });

    await sweepIdleEnvironments(deps, IDLE_MS, NOW, logger());

    expect(deps.listActive).toHaveBeenCalledTimes(1);
  });
});
