import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VersionConflictError } from '@agent-foundry/domain';
import { atomicWriteJson } from './fs-utils.js';
import { FileProjectRepository } from './project-repository.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('FileProjectRepository compatibility and concurrency', () => {
  it('reads a v0.1 project as version 1 without rewriting the file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-project-'));
    temporaryDirectories.push(dataDir);
    const fixture = JSON.parse(
      await readFile(new URL('./fixtures/project-v0.1.json', import.meta.url), 'utf8'),
    ) as unknown;
    await atomicWriteJson(join(dataDir, 'projects', 'legacy-project', 'project.json'), fixture);
    const projects = new FileProjectRepository(dataDir);

    const project = await projects.get('legacy-project');

    expect(project).toMatchObject({ id: 'legacy-project', version: 1, status: 'failed' });
    expect(project?.currentRunId).toBeUndefined();
  });

  it('rejects one of two concurrent project summary updates', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-project-'));
    temporaryDirectories.push(dataDir);
    const projects = new FileProjectRepository(dataDir);
    const project = {
      id: 'project-1',
      name: 'Project',
      workflowId: 'web-app-v1',
      status: 'queued' as const,
      version: 1,
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    };
    await projects.create(project);

    const results = await Promise.allSettled([
      projects.update({ ...project, status: 'running', updatedAt: '2026-07-14T12:01:00.000Z' }, 1),
      projects.update({ ...project, status: 'failed', updatedAt: '2026-07-14T12:02:00.000Z' }, 1),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(VersionConflictError) });
    expect((await projects.get('project-1'))?.version).toBe(2);
  });
});
