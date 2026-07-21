import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectVersion } from '@agent-foundry/contracts';
import { VersionConflictError } from '@agent-foundry/domain';
import { FileProjectVersionRepository } from './project-version-repository.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-project-version-'));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function makeVersion(overrides: Partial<ProjectVersion> = {}): ProjectVersion {
  return {
    schemaVersion: '1',
    id: 'version-1',
    projectId: 'project-1',
    sequence: 1,
    kind: 'run',
    runId: 'run-1',
    commit: 'abc123',
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: '2026-07-17T12:00:00.000Z',
    ...overrides,
  };
}

describe('FileProjectVersionRepository', () => {
  it('creates a version and reads it back by projectId and versionId', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();

    await repository.create(version);

    expect(await repository.get('project-1', 'version-1')).toEqual(version);
  });

  it('returns null for a version that does not exist', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());

    expect(await repository.get('project-1', 'missing')).toBeNull();
  });

  it('lists versions for a project sorted by sequence descending', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const first = makeVersion({ id: 'version-1', sequence: 1 });
    const second = makeVersion({ id: 'version-2', sequence: 2 });
    const third = makeVersion({ id: 'version-3', sequence: 3 });
    await repository.create(first);
    await repository.create(third);
    await repository.create(second);

    const versions = await repository.list('project-1');

    expect(versions.map((entry) => entry.id)).toEqual(['version-3', 'version-2', 'version-1']);
  });

  it('slices list results to the requested limit', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    await repository.create(makeVersion({ id: 'version-1', sequence: 1 }));
    await repository.create(makeVersion({ id: 'version-2', sequence: 2 }));
    await repository.create(makeVersion({ id: 'version-3', sequence: 3 }));

    const versions = await repository.list('project-1', 2);

    expect(versions.map((entry) => entry.id)).toEqual(['version-3', 'version-2']);
  });

  it('rejects creating a version that already exists', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);

    await expect(repository.create(version)).rejects.toThrow('already exists');
  });

  it('rejects creating a version that does not start at version 1', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());

    await expect(repository.create(makeVersion({ version: 2 }))).rejects.toThrow();
  });

  it('discards the exact unpromoted version used for failed-promotion compensation', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);

    await repository.discardUnpromoted(version);

    expect(await repository.get('project-1', 'version-1')).toBeNull();
  });

  it('refuses to discard a version that was updated after it was recorded', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);
    const promoted = await repository.update({ ...version, protected: true }, version.version);

    await expect(repository.discardUnpromoted(version)).rejects.toThrow(
      'no longer matches the unpromoted version',
    );
    expect(await repository.get('project-1', 'version-1')).toEqual(promoted);
  });

  it('holds discard validation and unlink behind the record update lock', async () => {
    const dataDir = await makeDataDir();
    const repository = new FileProjectVersionRepository(dataDir);
    const version = makeVersion();
    await repository.create(version);
    const recordPath = join(
      dataDir,
      'projects',
      version.projectId,
      'versions',
      `${version.id}.json`,
    );
    const lockPath = `${recordPath}.lock`;
    await mkdir(lockPath);
    let settled = false;

    const discard = repository.discardUnpromoted(version).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(settled).toBe(false);
    expect(await repository.get(version.projectId, version.id)).toEqual(version);
    await rm(lockPath, { recursive: true });
    await discard;
    expect(await repository.get(version.projectId, version.id)).toBeNull();
  });

  it('rejects one of two concurrent updates with a stale expectedVersion', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);

    const results = await Promise.allSettled([
      repository.update({ ...version, protected: true }, 1),
      repository.update({ ...version, protected: true }, 1),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(VersionConflictError) });
    expect((await repository.get('project-1', 'version-1'))?.version).toBe(2);
  });

  it('updates the protected flag and bumps the version counter', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);

    const updated = await repository.update({ ...version, protected: true }, 1);

    expect(updated).toMatchObject({ protected: true, version: 2 });
    expect(await repository.get('project-1', 'version-1')).toEqual(updated);
  });

  it('rejects an update that changes an immutable field other than protected', async () => {
    const repository = new FileProjectVersionRepository(await makeDataDir());
    const version = makeVersion();
    await repository.create(version);

    await expect(
      repository.update({ ...version, commit: 'different-commit' }, 1),
    ).rejects.toThrow();
    await expect(repository.update({ ...version, sequence: 99 }, 1)).rejects.toThrow();
    expect(await repository.get('project-1', 'version-1')).toEqual(version);
  });
});
