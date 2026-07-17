import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { NotFoundError } from '@agent-foundry/domain';
import { buildApp } from './app.js';

function makeVersion(overrides: Partial<ProjectVersion> = {}): ProjectVersion {
  return {
    schemaVersion: '1',
    id: 'version-1',
    projectId: 'project-1',
    sequence: 1,
    kind: 'run',
    runId: 'run-1',
    commit: 'abc123def456',
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeProjectVersionService {
  list: ReturnType<typeof vi.fn>;
  compare: ReturnType<typeof vi.fn>;
  revert: ReturnType<typeof vi.fn>;
  branchFrom: ReturnType<typeof vi.fn>;
  setProtected: ReturnType<typeof vi.fn>;
}

function buildFakeRuntime(overrides: Partial<FakeProjectVersionService> = {}): {
  runtime: Runtime;
  projectVersionService: FakeProjectVersionService;
} {
  const projectVersionService: FakeProjectVersionService = {
    list: vi.fn().mockResolvedValue([]),
    compare: vi.fn().mockResolvedValue({ diff: '' }),
    revert: vi.fn().mockResolvedValue(makeVersion()),
    branchFrom: vi.fn().mockResolvedValue({ branchName: 'branch', version: makeVersion() }),
    setProtected: vi.fn().mockResolvedValue(makeVersion()),
    ...overrides,
  };
  const runtime = {
    config: { webOrigin: 'http://localhost:3000' },
    projectVersionService,
  } as unknown as Runtime;
  return { runtime, projectVersionService };
}

describe('project version API', () => {
  it('lists versions for a project with the default limit', async () => {
    const versions = [makeVersion()];
    const { runtime, projectVersionService } = buildFakeRuntime({
      list: vi.fn().mockResolvedValue(versions),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'GET', url: '/projects/project-1/versions' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ versions });
    expect(projectVersionService.list).toHaveBeenCalledWith('project-1', 50);
    await app.close();
  });

  it('passes an explicit limit through to the service', async () => {
    const { runtime, projectVersionService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/versions?limit=10',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(projectVersionService.list).toHaveBeenCalledWith('project-1', 10);
    await app.close();
  });

  it('compares two versions and returns the diff', async () => {
    const { runtime, projectVersionService } = buildFakeRuntime({
      compare: vi.fn().mockResolvedValue({ diff: '+added\n-removed' }),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/versions/compare?from=version-1&to=version-2',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ diff: '+added\n-removed' });
    expect(projectVersionService.compare).toHaveBeenCalledWith(
      'project-1',
      'version-1',
      'version-2',
    );
    await app.close();
  });

  it('reverts to a version', async () => {
    const version = makeVersion({ kind: 'revert', parentVersionId: 'version-1' });
    const { runtime, projectVersionService } = buildFakeRuntime({
      revert: vi.fn().mockResolvedValue(version),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/versions/version-1/revert',
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ version });
    expect(projectVersionService.revert).toHaveBeenCalledWith('project-1', 'version-1');
    await app.close();
  });

  it('branches from a version with an optional label', async () => {
    const version = makeVersion({
      kind: 'branch',
      parentVersionId: 'version-1',
      branchName: 'wip',
    });
    const { runtime, projectVersionService } = buildFakeRuntime({
      branchFrom: vi.fn().mockResolvedValue({ branchName: 'wip', version }),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/versions/version-1/branch',
      payload: { label: 'wip' },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ branchName: 'wip', version });
    expect(projectVersionService.branchFrom).toHaveBeenCalledWith('project-1', 'version-1', 'wip');
    await app.close();
  });

  it('branches from a version without a label', async () => {
    const { runtime, projectVersionService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/versions/version-1/branch',
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(projectVersionService.branchFrom).toHaveBeenCalledWith(
      'project-1',
      'version-1',
      undefined,
    );
    await app.close();
  });

  it('sets a version as protected', async () => {
    const version = makeVersion({ protected: true });
    const { runtime, projectVersionService } = buildFakeRuntime({
      setProtected: vi.fn().mockResolvedValue(version),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/versions/version-1/protect',
      payload: { protected: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ version });
    expect(projectVersionService.setProtected).toHaveBeenCalledWith('project-1', 'version-1', true);
    await app.close();
  });

  it('404s when the service reports an unknown version id', async () => {
    const { runtime } = buildFakeRuntime({
      revert: vi.fn().mockRejectedValue(new NotFoundError('Version missing-version not found')),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/versions/missing-version/revert',
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFoundError' });
    await app.close();
  });
});
