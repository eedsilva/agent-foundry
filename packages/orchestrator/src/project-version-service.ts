import {
  EMPTY_TREE_HASH,
  type ArtifactReference,
  type ProjectVersion,
} from '@agent-foundry/contracts';
import {
  latestArtifactsByName,
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type IdGenerator,
  type ProjectVersionRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';

export interface RecordFromStepInput {
  projectId: string;
  runId: string;
  stepRunId: string;
  attemptId: string;
  commit: string;
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
    const version = await this.buildVersion(input.projectId, 'run', {
      runId: input.runId,
      stepRunId: input.stepRunId,
      attemptId: input.attemptId,
      commit: input.commit,
    });
    await this.versions.create(version);
    return version;
  }

  /**
   * The ProjectVersion a run's Supabase stack is bound to (#617). ADR 0080
   * requires a candidate environment to name the exact commit it runs, so
   * recovery "never starts an application with a mismatched commit and
   * environment". Provisioning happens before any mutating step, so a brand
   * new project has no ledger entry yet and gets exactly one baseline entry
   * for the scaffold commit `ensureGit` already created.
   *
   * A project that already has history must produce a ledger entry belonging
   * to this run *and* naming the current HEAD: that is the replay case, and
   * reusing it appends nothing. Anything else — a foreign run's entry, or an
   * entry whose commit is no longer HEAD — fails closed here, before any
   * container or model call, rather than binding the stack to a commit the
   * workspace is not on.
   */
  async baselineForRun(projectId: string, runId: string, head: string): Promise<ProjectVersion> {
    const history = await this.versions.list(projectId);
    if (history.length === 0) {
      const version = await this.buildVersion(projectId, 'run', { runId, commit: head });
      await this.versions.create(version);
      return version;
    }
    const match = history.find((version) => version.runId === runId && version.commit === head);
    if (match) return match;
    throw new ValidationError(
      `Project ${projectId} has version history but no entry for run ${runId} at HEAD ${head}; ` +
        'the environment cannot be bound to a commit it does not name.',
    );
  }

  /** Compensates only the exact ledger write returned by a promotion that did not complete. */
  discardUnpromoted(version: ProjectVersion): Promise<void> {
    return this.versions.discardUnpromoted(version);
  }

  list(projectId: string, limit?: number): Promise<ProjectVersion[]> {
    return this.versions.list(projectId, limit);
  }

  get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    return this.versions.get(projectId, versionId);
  }

  async hasHistory(projectId: string): Promise<boolean> {
    return (await this.versions.list(projectId, 1)).length > 0;
  }

  async compare(
    projectId: string,
    fromVersionId: string,
    toVersionId: string,
  ): Promise<{ diff: string }> {
    const fromCommit =
      fromVersionId === EMPTY_TREE_HASH
        ? EMPTY_TREE_HASH
        : (await this.requireVersion(projectId, fromVersionId)).commit;
    const to = await this.requireVersion(projectId, toVersionId);
    return { diff: await this.workspaces.diff(projectId, fromCommit, to.commit) };
  }

  /**
   * ponytail: revert/branchFrom mutate the shared git working tree with no
   * lock coordinating against an in-flight WorkflowOrchestrator step on the
   * same project (checkpoint/commit/rollback have never been locked either —
   * this app has always assumed one active mutator per project). Calling
   * revert or branch while a run is actively executing a mutating step can
   * corrupt that step's checkpoint semantics. Upgrade path: guard on the
   * project having no in-flight run, or take a per-project workspace lock,
   * if concurrent use becomes real (see ADR 0021).
   */
  async revert(projectId: string, toVersionId: string): Promise<ProjectVersion> {
    const target = await this.requireVersion(projectId, toVersionId);
    await this.workspaces.restoreTree(projectId, target.commit);
    const commit =
      (await this.workspaces.commit(projectId, `revert to ${target.id}`)) ??
      (await this.workspaces.head(projectId))!;
    const version = await this.buildVersion(projectId, 'revert', {
      parentVersionId: toVersionId,
      commit,
    });
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
    const version = await this.buildVersion(projectId, 'branch', {
      parentVersionId: fromVersionId,
      branchName,
      commit,
    });
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

  /** Fills the scaffolding every ProjectVersion shares; callers supply only the kind-specific fields. */
  private async buildVersion(
    projectId: string,
    kind: ProjectVersion['kind'],
    fields: Partial<ProjectVersion> & { commit: string },
  ): Promise<ProjectVersion> {
    const [sequence, artifacts] = await Promise.all([
      this.nextSequence(projectId),
      this.artifactSnapshot(projectId),
    ]);
    return {
      schemaVersion: '1',
      id: this.ids.next(),
      projectId,
      sequence,
      kind,
      artifacts,
      protected: false,
      version: 1,
      createdAt: this.clock.now().toISOString(),
      ...fields,
    } as ProjectVersion;
  }

  /**
   * Trusts single-writer-per-project, same as StepAttempt.sequence elsewhere.
   * ponytail: `list(projectId, 1)` scans every version file to find the
   * latest one, so this is O(n) per write and O(n^2) over a project's
   * lifetime. Acceptable at this app's scale (ADR 0003); upgrade to a
   * monotonic-filename or counter-file scheme if a project's version count
   * makes this measurable.
   */
  private async nextSequence(projectId: string): Promise<number> {
    const [latest] = await this.versions.list(projectId, 1);
    return (latest?.sequence ?? 0) + 1;
  }

  private async artifactSnapshot(projectId: string): Promise<ArtifactReference[]> {
    const latest = latestArtifactsByName(await this.artifacts.listMetadata(projectId));
    return [...latest.values()].map(({ name, revision, sha256 }) => ({ name, revision, sha256 }));
  }
}
