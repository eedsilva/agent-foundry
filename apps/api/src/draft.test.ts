import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import type { WorkflowRun } from '@agent-foundry/contracts';
import { NotFoundError } from '@agent-foundry/domain';
import { buildApp } from './app.js';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    status: 'failed',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeProjectService {
  getDraft: ReturnType<typeof vi.fn>;
  discardDraft: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function buildFakeRuntime(overrides: Partial<FakeProjectService> = {}): {
  runtime: Runtime;
  projectService: FakeProjectService;
} {
  const projectService: FakeProjectService = {
    getDraft: vi.fn().mockResolvedValue({ draftBranch: 'draft/run-1', diff: '+x' }),
    discardDraft: vi.fn().mockResolvedValue(makeRun()),
    retry: vi.fn().mockResolvedValue({ id: 'project-1', currentRunId: 'run-2' }),
    ...overrides,
  };
  const runtime = {
    config: { webOrigin: 'http://localhost:3000' },
    projectService,
  } as unknown as Runtime;
  return { runtime, projectService };
}

describe('draft API', () => {
  it('returns a draft diff', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ draftBranch: 'draft/run-1', diff: '+x' });
    expect(projectService.getDraft).toHaveBeenCalledWith('run-1');
    await app.close();
  });

  it('404s when a run has no draft', async () => {
    const { runtime } = buildFakeRuntime({
      getDraft: vi.fn().mockRejectedValue(new NotFoundError('Run run-1 has no preserved draft')),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(404);
    await app.close();
  });

  it('discards a draft with an actor', async () => {
    const run = makeRun({
      execution: {
        activeElapsedMs: 0,
        consecutiveRepairs: 0,
        ceiling: {
          reason: 'active-time',
          reachedAt: new Date().toISOString(),
          draftBranch: 'draft/run-1',
          draftCommit: 'sha-1',
          discardedAt: new Date().toISOString(),
          discardedBy: { kind: 'user', id: 'ed' },
        },
      },
    });
    const { runtime, projectService } = buildFakeRuntime({
      discardDraft: vi.fn().mockResolvedValue(run),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-1/draft/discard',
      payload: { actor: { kind: 'user', id: 'ed' }, reason: 'not needed' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ run });
    expect(projectService.discardDraft).toHaveBeenCalledWith('run-1', {
      actor: { kind: 'user', id: 'ed' },
      reason: 'not needed',
    });
    await app.close();
  });

  it('rejects discarding a draft without an actor', async () => {
    const { runtime } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-1/draft/discard',
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(400);
    await app.close();
  });

  it('retries a project with an optional prompt', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/retry',
      payload: { prompt: 'try again smaller' },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(projectService.retry).toHaveBeenCalledWith('project-1', { prompt: 'try again smaller' });
    await app.close();
  });

  it('retries a project with no body (back-compatible)', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'POST', url: '/projects/project-1/retry' });

    expect(response.statusCode, response.body).toBe(202);
    expect(projectService.retry).toHaveBeenCalledWith('project-1', {});
    await app.close();
  });
});
