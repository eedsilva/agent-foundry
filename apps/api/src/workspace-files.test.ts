import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import { NotFoundError } from '@agent-foundry/domain';
import { buildApp } from './app.js';

interface FakeWorkspaceService {
  listFiles: ReturnType<typeof vi.fn>;
  readWorkspaceFile: ReturnType<typeof vi.fn>;
}

function buildFakeRuntime(overrides: Partial<FakeWorkspaceService> = {}): {
  runtime: Runtime;
  workspaces: FakeWorkspaceService;
} {
  const workspaces: FakeWorkspaceService = {
    listFiles: vi.fn().mockResolvedValue([]),
    readWorkspaceFile: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
  const runtime = {
    config: { webOrigin: 'http://localhost:3000' },
    workspaces,
  } as unknown as Runtime;
  return { runtime, workspaces };
}

describe('workspace files API', () => {
  it("lists a project workspace's files", async () => {
    const { runtime, workspaces } = buildFakeRuntime({
      listFiles: vi.fn().mockResolvedValue(['README.md', 'src/App.tsx']),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/workspace/files',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ files: ['README.md', 'src/App.tsx'] });
    expect(workspaces.listFiles).toHaveBeenCalledWith('project-1');
    await app.close();
  });

  it("reads one file's content by its workspace-relative path", async () => {
    const { runtime, workspaces } = buildFakeRuntime({
      readWorkspaceFile: vi.fn().mockResolvedValue('export {}\n'),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/workspace/files/content?path=src%2FApp.tsx',
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ path: 'src/App.tsx', content: 'export {}\n' });
    expect(workspaces.readWorkspaceFile).toHaveBeenCalledWith('project-1', 'src/App.tsx');
    await app.close();
  });

  it('404s when the service rejects a path that escapes the workspace', async () => {
    const { runtime } = buildFakeRuntime({
      readWorkspaceFile: vi
        .fn()
        .mockRejectedValue(new NotFoundError('Path escapes the workspace: ../../etc/passwd')),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/workspace/files/content?path=..%2F..%2Fetc%2Fpasswd',
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFoundError' });
    await app.close();
  });

  it('404s when the service rejects a path excluded from the listing', async () => {
    const { runtime } = buildFakeRuntime({
      readWorkspaceFile: vi.fn().mockRejectedValue(new NotFoundError('File is not listable: .env')),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/workspace/files/content?path=.env',
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: 'NotFoundError' });
    await app.close();
  });

  it('requires a non-empty path query param', async () => {
    const { runtime } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'GET',
      url: '/projects/project-1/workspace/files/content',
    });

    expect(response.statusCode, response.body).toBe(400);
    await app.close();
  });
});
