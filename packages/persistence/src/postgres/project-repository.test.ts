import { expect, it } from 'vitest';
import type { Project } from '@agent-foundry/contracts';
import { NotFoundError, VersionConflictError } from '@agent-foundry/domain';
import { PostgresProjectRepository } from './project-repository.js';
import { describePostgres } from './testing.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Project One',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt: '2026-07-14T12:00:00.000Z',
    updatedAt: '2026-07-14T12:00:00.000Z',
    ...overrides,
  };
}

describePostgres('PostgresProjectRepository', (ctx) => {
  it('creates, gets, and lists projects newest-created-first with a limit', async () => {
    const repo = new PostgresProjectRepository(ctx.db());
    const first = makeProject({
      id: 'project-1',
      createdAt: '2026-07-14T12:00:00.000Z',
      updatedAt: '2026-07-14T12:00:00.000Z',
    });
    const second = makeProject({
      id: 'project-2',
      createdAt: '2026-07-14T12:01:00.000Z',
      updatedAt: '2026-07-14T12:01:00.000Z',
    });
    const third = makeProject({
      id: 'project-3',
      createdAt: '2026-07-14T12:02:00.000Z',
      updatedAt: '2026-07-14T12:02:00.000Z',
    });

    await repo.create(first);
    await repo.create(second);
    await repo.create(third);

    expect(await repo.get('project-2')).toEqual(second);
    expect(await repo.get('missing-project')).toBeNull();
    expect((await repo.list()).map((project) => project.id)).toEqual([
      'project-3',
      'project-2',
      'project-1',
    ]);
    expect((await repo.list(2)).map((project) => project.id)).toEqual(['project-3', 'project-2']);
  });

  it('rejects create with a non-1 version and rejects duplicate ids', async () => {
    const repo = new PostgresProjectRepository(ctx.db());

    await expect(repo.create(makeProject({ version: 2 }))).rejects.toThrow(/version 1/i);

    await repo.create(makeProject());

    await expect(repo.create(makeProject())).rejects.toThrow(/already exists/i);
  });

  it('updates and bumps the version on both the returned entity and a fresh get', async () => {
    const repo = new PostgresProjectRepository(ctx.db());
    const project = makeProject();
    await repo.create(project);

    const updated = await repo.update(
      { ...project, status: 'running', updatedAt: '2026-07-14T12:05:00.000Z' },
      1,
    );

    expect(updated).toMatchObject({ status: 'running', version: 2 });
    expect(await repo.get('project-1')).toEqual(updated);
  });

  it('rejects a second CAS update at the same expected version', async () => {
    const repo = new PostgresProjectRepository(ctx.db());
    const project = makeProject();
    await repo.create(project);
    await repo.update({ ...project, status: 'running', updatedAt: '2026-07-14T12:05:00.000Z' }, 1);

    const rejection = repo.update(
      { ...project, status: 'paused', updatedAt: '2026-07-14T12:06:00.000Z' },
      1,
    );
    await expect(rejection).rejects.toBeInstanceOf(VersionConflictError);
    await expect(rejection).rejects.toMatchObject({ expectedVersion: 1, actualVersion: 2 });
  });

  it('allows exactly one of five concurrent CAS updates at the same expected version', async () => {
    const repo = new PostgresProjectRepository(ctx.db());
    const project = makeProject();
    await repo.create(project);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        repo.update({ ...project, status: 'running', updatedAt: `2026-07-14T12:0${i}:00.000Z` }, 1),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const result of rejected as PromiseRejectedResult[]) {
      expect(result.reason).toBeInstanceOf(VersionConflictError);
      expect(result.reason).toMatchObject({ expectedVersion: 1, actualVersion: 2 });
    }
    expect((await repo.get('project-1'))?.version).toBe(2);
  });

  it('throws NotFoundError when updating a project that does not exist', async () => {
    const repo = new PostgresProjectRepository(ctx.db());

    await expect(repo.update(makeProject(), 1)).rejects.toBeInstanceOf(NotFoundError);
  });
});
