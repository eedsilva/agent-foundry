import type { ArtifactReference, ProjectVersion } from '@agent-foundry/contracts';
import {
  NotFoundError,
  type ArtifactStore,
  type Clock,
  type IdGenerator,
  type ProjectVersionRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';

interface RecordFromStepInput {
  projectId: string;
  runId: string;
  stepRunId: string;
  attemptId: string;
  commit: string;
  previewSessionId?: string;
  label?: string;
}

/**
 * Records the immutable ProjectVersion ledger after mutating workflow steps,
 * and offers compare/revert/branch/protect on top of that history.
 */
export class ProjectVersionService {
  constructor(
    private readonly versions: ProjectVersionRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async recordFromStep(input: RecordFromStepInput): Promise<ProjectVersion> {
    const version: ProjectVersion = {
      schemaVersion: '1',
      id: this.ids.next(),
      projectId: input.projectId,
      sequence: await this.nextSequence(input.projectId),
      kind: 'run',
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      commit: input.commit,
      ...(input.previewSessionId ? { previewSessionId: input.previewSessionId } : {}),
      artifacts: await this.artifactSnapshot(input.projectId),
      ...(input.label ? { label: input.label } : {}),
      protected: false,
      version: 1,
      createdAt: this.clock.now().toISOString(),
    };
    await this.versions.create(version);
    return version;
  }

  list(projectId: string, limit?: number): Promise<ProjectVersion[]> {
    return this.versions.list(projectId, limit);
  }

  async compare(
    projectId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<{ diff: string }> {
    const from = await this.requireVersion(projectId, fromVersionId);
    const to = await this.requireVersion(projectId, toVersionId);
    return { diff: await this.workspaces.diff(projectId, from.commit, to.commit) };
  }

  async revert(projectId: string, toVersionId: string): Promise<ProjectVersion> {
    const target = await this.requireVersion(projectId, toVersionId);
    await this.workspaces.restoreTree(projectId, target.commit);
    const commit =
      (await this.workspaces.commit(projectId, `revert to ${target.id}`)) ??
      (await this.workspaces.head(projectId))!;
    const version: ProjectVersion = {
      schemaVersion: '1',
      id: this.ids.next(),
      projectId,
      sequence: await this.nextSequence(projectId),
      kind: 'revert',
      parentVersionId: toVersionId,
      commit,
      artifacts: await this.artifactSnapshot(projectId),
      protected: false,
      version: 1,
      createdAt: this.clock.now().toISOString(),
    };
    await this.versions.create(version);
    return version;
  }

  async branchFrom(
    projectId: string,
    fromVersionId: string,
    label?: string,
  ): Promise<{ branchName: string; version: ProjectVersion }> {
    const source = await this.requireVersion(projectId, fromVersionId);
    const branchName = label ? `branch/${label}` : `branch/version-${source.sequence}`;
    const commit = await this.workspaces.createBranch(projectId, source.commit, branchName);
    const version: ProjectVersion = {
      schemaVersion: '1',
      id: this.ids.next(),
      projectId,
      sequence: await this.nextSequence(projectId),
      kind: 'branch',
      parentVersionId: fromVersionId,
      branchName,
      commit,
      artifacts: await this.artifactSnapshot(projectId),
      protected: false,
      version: 1,
      createdAt: this.clock.now().toISOString(),
    };
    await this.versions.create(version);
    return { branchName, version };
  }

  async setProtected(
    projectId: string,
    versionId: string,
    protectedFlag: boolean,
  ): Promise<ProjectVersion> {
    const version = await this.requireVersion(projectId, versionId);
    return this.versions.update({ ...version, protected: protectedFlag }, version.version);
  }

  private async requireVersion(projectId: string, versionId: string): Promise<ProjectVersion> {
    const version = await this.versions.get(projectId, versionId);
    if (!version) throw new NotFoundError(`ProjectVersion ${versionId} not found`);
    return version;
  }

  /** Trusts single-writer-per-project, same as StepAttempt.sequence elsewhere. */
  private async nextSequence(projectId: string): Promise<number> {
    const [latest] = await this.versions.list(projectId, 1);
    return (latest?.sequence ?? 0) + 1;
  }

  private async artifactSnapshot(projectId: string): Promise<ArtifactReference[]> {
    const metadata = await this.artifacts.listMetadata(projectId);
    const latest = new Map<string, ArtifactReference>();
    for (const item of metadata) {
      const current = latest.get(item.name);
      if (!current || current.revision < item.revision) {
        latest.set(item.name, { name: item.name, revision: item.revision, sha256: item.sha256 });
      }
    }
    return [...latest.values()];
  }
}
