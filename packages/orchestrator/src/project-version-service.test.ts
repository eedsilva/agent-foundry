import type { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { ArtifactMetadata, ProjectVersion, StoredArtifact } from '@agent-foundry/contracts';
import {
  NotFoundError,
  VersionConflictError,
  type ArtifactBlobPutInput,
  type ArtifactStore,
  type Clock,
  type IdGenerator,
  type ProjectVersionRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { ProjectVersionService } from './project-version-service.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
}

class SequentialIds implements IdGenerator {
  private n = 0;
  next(): string {
    this.n += 1;
    return `id-${this.n}`;
  }
}

class FakeVersions implements ProjectVersionRepository {
  readonly store = new Map<string, ProjectVersion>();
  create(version: ProjectVersion): Promise<void> {
    this.store.set(`${version.projectId}/${version.id}`, { ...version });
    return Promise.resolve();
  }
  discardUnpromoted(version: ProjectVersion): Promise<void> {
    this.store.delete(`${version.projectId}/${version.id}`);
    return Promise.resolve();
  }
  get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    return Promise.resolve(this.store.get(`${projectId}/${versionId}`) ?? null);
  }
  list(projectId: string, limit?: number): Promise<ProjectVersion[]> {
    const all = [...this.store.values()]
      .filter((version) => version.projectId === projectId)
      .sort((left, right) => right.sequence - left.sequence);
    return Promise.resolve(limit ? all.slice(0, limit) : all);
  }
  update(version: ProjectVersion, expectedVersion: number): Promise<ProjectVersion> {
    const key = `${version.projectId}/${version.id}`;
    const existing = this.store.get(key);
    if (!existing) throw new Error(`version ${version.id} missing`);
    if (existing.version !== expectedVersion) {
      throw new VersionConflictError(
        'project-version',
        version.id,
        expectedVersion,
        existing.version,
      );
    }
    const updated = { ...version, version: expectedVersion + 1 };
    this.store.set(key, updated);
    return Promise.resolve({ ...updated });
  }
}

/** Only the methods ProjectVersionService actually calls do anything interesting. */
class FakeWorkspaces implements WorkspaceManager {
  commitReturn: string | null = 'new-commit';
  headValue: string | null = 'head-commit';
  readonly diffCalls: Array<[string, string]> = [];
  readonly restoreTreeCalls: string[] = [];
  readonly commitCalls: string[] = [];
  readonly createBranchCalls: Array<{ ref: string; name: string }> = [];

  projectRoot(projectId: string): string {
    return `/fake/${projectId}`;
  }
  workspacePath(projectId: string): string {
    return `/fake/${projectId}/workspace`;
  }
  ensure(): Promise<void> {
    return Promise.resolve();
  }
  writePrd(): Promise<void> {
    return Promise.resolve();
  }
  applyScaffold(): Promise<void> {
    return Promise.resolve();
  }
  writeRunContext(): Promise<{ requestPath: string; schemaPath: string; inputPaths: string[] }> {
    return Promise.resolve({
      requestPath: 'request.md',
      schemaPath: 'schema.json',
      inputPaths: [],
    });
  }
  ensureGit(): Promise<void> {
    return Promise.resolve();
  }
  isClean(): Promise<boolean> {
    return Promise.resolve(true);
  }
  checkpoint(): Promise<string> {
    return Promise.resolve('checkpoint');
  }
  rollback(): Promise<void> {
    return Promise.resolve();
  }
  preserveDraft(_projectId: string, runId: string) {
    return Promise.resolve({ draftBranch: `draft/${runId}`, draftCommit: 'draft', created: true });
  }
  discardDraft(): Promise<void> {
    return Promise.resolve();
  }
  commit(_projectId: string, message: string): Promise<string | null> {
    this.commitCalls.push(message);
    return Promise.resolve(this.commitReturn);
  }
  head(): Promise<string | null> {
    return Promise.resolve(this.headValue);
  }
  diff(_projectId: string, fromRef: string, toRef: string): Promise<string> {
    this.diffCalls.push([fromRef, toRef]);
    return Promise.resolve(`diff ${fromRef}..${toRef}`);
  }
  restoreTree(_projectId: string, ref: string): Promise<void> {
    this.restoreTreeCalls.push(ref);
    return Promise.resolve();
  }
  createBranch(_projectId: string, ref: string, name: string): Promise<string> {
    this.createBranchCalls.push({ ref, name });
    return Promise.resolve(ref);
  }
}

class FakeArtifacts implements ArtifactStore {
  metadata: ArtifactMetadata[] = [];
  put(): Promise<StoredArtifact> {
    throw new Error('not used by ProjectVersionService');
  }
  putBlob(_input: ArtifactBlobPutInput, _source: Readable): Promise<ArtifactMetadata> {
    throw new Error('not used by ProjectVersionService');
  }
  getBlobStream(): Promise<Readable | null> {
    return Promise.resolve(null);
  }
  getLatest(): Promise<StoredArtifact | null> {
    return Promise.resolve(null);
  }
  getRevision(): Promise<StoredArtifact | null> {
    return Promise.resolve(null);
  }
  listLatest(): Promise<StoredArtifact[]> {
    return Promise.resolve([]);
  }
  listMetadata(): Promise<ArtifactMetadata[]> {
    return Promise.resolve(this.metadata);
  }
  reapExpired(): Promise<number> {
    return Promise.resolve(0);
  }
}

function artifactMeta(name: string, revision: number, sha256: string): ArtifactMetadata {
  return {
    projectId: 'project-1',
    name,
    revision,
    contentType: 'application/json',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'test',
    sha256,
  };
}

function makeService() {
  const versions = new FakeVersions();
  const workspaces = new FakeWorkspaces();
  const artifacts = new FakeArtifacts();
  const clock = new FakeClock(new Date('2026-01-01T00:00:00.000Z'));
  const ids = new SequentialIds();
  const service = new ProjectVersionService(versions, workspaces, artifacts, clock, ids);
  return { service, versions, workspaces, artifacts, clock, ids };
}

describe('ProjectVersionService', () => {
  describe('recordFromStep', () => {
    it('builds sequence 1 then 2 on successive calls', async () => {
      const { service } = makeService();
      const first = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      expect(first.sequence).toBe(1);
      expect(first.kind).toBe('run');
      expect(first.runId).toBe('run-1');
      expect(first.commit).toBe('commit-a');
      expect(first.version).toBe(1);
      expect(first.protected).toBe(false);

      const second = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-2',
        attemptId: 'attempt-2',
        commit: 'commit-b',
      });
      expect(second.sequence).toBe(2);
    });

    it('snapshots only the highest revision per artifact name', async () => {
      const { service, artifacts } = makeService();
      artifacts.metadata = [
        artifactMeta('plan', 1, 'a'.repeat(64)),
        artifactMeta('plan', 2, 'b'.repeat(64)),
        artifactMeta('implementation', 1, 'c'.repeat(64)),
      ];
      const version = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      expect(version.artifacts).toHaveLength(2);
      expect(version.artifacts).toContainEqual({
        name: 'plan',
        revision: 2,
        sha256: 'b'.repeat(64),
      });
      expect(version.artifacts).toContainEqual({
        name: 'implementation',
        revision: 1,
        sha256: 'c'.repeat(64),
      });
    });
  });

  describe('compare', () => {
    it('compares a first-run version from the empty tree', async () => {
      const { service, workspaces } = makeService();
      const first = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });

      await expect(
        service.compare('project-1', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', first.id),
      ).resolves.toEqual({ diff: 'diff 4b825dc642cb6eb9a060e54bf8d69288fbee4904..commit-a' });
      expect(workspaces.diffCalls).toEqual([
        ['4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'commit-a'],
      ]);
    });

    it('returns the diff between the two versions', async () => {
      const { service, workspaces } = makeService();
      const from = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      const to = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-2',
        attemptId: 'attempt-2',
        commit: 'commit-b',
      });

      const result = await service.compare('project-1', from.id, to.id);

      expect(result).toEqual({ diff: 'diff commit-a..commit-b' });
      expect(workspaces.diffCalls).toEqual([['commit-a', 'commit-b']]);
    });

    it('throws NotFoundError when either version id is missing', async () => {
      const { service } = makeService();
      const existing = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      await expect(service.compare('project-1', 'missing', existing.id)).rejects.toThrow(
        NotFoundError,
      );
      await expect(service.compare('project-1', existing.id, 'missing')).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('revert', () => {
    it('produces a new version with parentVersionId set and never mutates the original', async () => {
      const { service, workspaces, versions } = makeService();
      const original = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      workspaces.commitReturn = 'revert-commit';

      const reverted = await service.revert('project-1', original.id);

      expect(reverted.kind).toBe('revert');
      expect(reverted.parentVersionId).toBe(original.id);
      expect(reverted.commit).toBe('revert-commit');
      expect(reverted.sequence).toBe(2);
      expect(workspaces.restoreTreeCalls).toEqual(['commit-a']);
      expect(workspaces.commitCalls).toEqual([`revert to ${original.id}`]);

      const stillOriginal = await versions.get('project-1', original.id);
      expect(stillOriginal).toEqual(original);
    });

    it('falls back to head() when the tree already matched (commit returns null)', async () => {
      const { service, workspaces } = makeService();
      const original = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      workspaces.commitReturn = null;
      workspaces.headValue = 'head-commit';

      const reverted = await service.revert('project-1', original.id);

      expect(reverted.commit).toBe('head-commit');
    });

    it('throws NotFoundError for a missing version id', async () => {
      const { service } = makeService();
      await expect(service.revert('project-1', 'missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('branchFrom', () => {
    it('produces a version with branchName set and never moves HEAD', async () => {
      const { service, workspaces } = makeService();
      const original = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });

      const { branchName, version } = await service.branchFrom(
        'project-1',
        original.id,
        'my-feature',
      );

      expect(branchName).toBe('branch/my-feature');
      expect(version.kind).toBe('branch');
      expect(version.branchName).toBe('branch/my-feature');
      expect(version.parentVersionId).toBe(original.id);
      expect(version.commit).toBe('commit-a');
      expect(workspaces.createBranchCalls).toEqual([
        { ref: 'commit-a', name: 'branch/my-feature' },
      ]);
      expect(workspaces.commitCalls).toHaveLength(0);
      expect(workspaces.restoreTreeCalls).toHaveLength(0);
    });

    it('derives the branch name from the source sequence when no label is given', async () => {
      const { service } = makeService();
      const original = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });

      const { branchName } = await service.branchFrom('project-1', original.id);

      expect(branchName).toBe(`branch/version-${original.sequence}`);
    });

    it('throws NotFoundError for a missing version id', async () => {
      const { service } = makeService();
      await expect(service.branchFrom('project-1', 'missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('setProtected', () => {
    it('updates only the protected flag', async () => {
      const { service } = makeService();
      const original = await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });

      const updated = await service.setProtected('project-1', original.id, true);

      expect(updated.protected).toBe(true);
      expect(updated.version).toBe(original.version + 1);
      expect(updated.commit).toBe(original.commit);
    });

    it('throws NotFoundError for a missing version id', async () => {
      const { service } = makeService();
      await expect(service.setProtected('project-1', 'missing', true)).rejects.toThrow(
        NotFoundError,
      );
    });
  });

  describe('list', () => {
    it('delegates to the repository', async () => {
      const { service } = makeService();
      await service.recordFromStep({
        projectId: 'project-1',
        runId: 'run-1',
        stepRunId: 'step-1',
        attemptId: 'attempt-1',
        commit: 'commit-a',
      });
      const result = await service.list('project-1');
      expect(result).toHaveLength(1);
    });
  });
});
