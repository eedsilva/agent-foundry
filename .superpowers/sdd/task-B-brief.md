# Task B: ProjectVersionService + orchestrator hook + composition wiring

## Where this fits

Issue #40 records a `ProjectVersion` after every mutating workflow step
commits, and offers compare/revert/branch/protect on top of that ledger.
The contract and domain ports (`ProjectVersionRepository`, and
`WorkspaceManager.diff/restoreTree/createBranch`) already exist on this
branch (foundation commit). A sibling task (running in parallel, in a
different worktree) is implementing `FileProjectVersionRepository` and the
`FileWorkspaceManager` git methods against those same port interfaces —
you do not need to wait for it; code against the interfaces in
`packages/domain/src/ports.ts`, and your own tests use fakes.

## Part 1 — new `packages/orchestrator/src/project-version-service.ts`

Constructor-injection style like `packages/orchestrator/src/preview-service.ts`
(read it for the pattern — plain classes, no framework):

```ts
export class ProjectVersionService {
  constructor(
    private readonly versions: ProjectVersionRepository,
    private readonly workspaces: WorkspaceManager,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}
```

Methods:

- `recordFromStep(input: { projectId: string; runId: string; stepRunId: string; attemptId: string; commit: string; previewSessionId?: string; label?: string }): Promise<ProjectVersion>`
  Builds a full `ProjectVersion` (`kind: 'run'`, `schemaVersion: '1'`,
  `id: this.ids.next()`, `sequence` from the helper below, `version: 1`,
  `createdAt: this.clock.now().toISOString()`, `artifacts` from the
  snapshot helper below) and calls `this.versions.create(version)`.

- `list(projectId, limit?)` → `this.versions.list(projectId, limit)`.

- `compare(projectId, fromVersionId, toVersionId): Promise<{ diff: string }>`
  Loads both versions via `this.versions.get`; throw `NotFoundError` (from
  `@agent-foundry/domain`) if either is missing. Returns
  `{ diff: await this.workspaces.diff(projectId, from.commit, to.commit) }`.

- `revert(projectId, toVersionId): Promise<ProjectVersion>`
  Load the target version (`NotFoundError` if missing). Call
  `this.workspaces.restoreTree(projectId, target.commit)`, then
  `const commit = await this.workspaces.commit(projectId, \`revert to ${target.id}\`)`.
  `commit` returning `null` means the tree already matched (nothing to
  stage) — in that case use `(await this.workspaces.head(projectId))!` as
  the commit instead of failing. Record a new version: `kind: 'revert'`,
  `parentVersionId: toVersionId`, same `artifacts`/`sequence` helpers as
  above. Never call `this.versions.update` on the target — the target
  record is untouched.

- `branchFrom(projectId, fromVersionId, label?): Promise<{ branchName: string; version: ProjectVersion }>`
  Load the source version (`NotFoundError` if missing). Derive
  `branchName = label ? \`branch/${label}\` : \`branch/version-${source.sequence}\`\`.
  Call `await this.workspaces.createBranch(projectId, source.commit, branchName)`
  (it returns `source.commit`'s sha — use that as the new version's
  `commit`). Record a new version: `kind: 'branch'`, `parentVersionId:
  fromVersionId`, `branchName`. This never touches HEAD — the current
  branch is unaffected.

- `setProtected(projectId, versionId, protectedFlag): Promise<ProjectVersion>`
  Load the version (`NotFoundError` if missing), then
  `this.versions.update({ ...version, protected: protectedFlag }, version.version)`.

Private helpers:
- `nextSequence(projectId)`: `const [latest] = await this.versions.list(projectId, 1); return (latest?.sequence ?? 0) + 1;` — this trusts single-writer-per-project, the same assumption `StepAttempt.sequence` already relies on elsewhere in this codebase. Don't build reservation-file machinery for this.
- `artifactSnapshot(projectId)`: same "latest revision per artifact name" logic as the private `pauseSnapshot` method in `packages/orchestrator/src/workflow-orchestrator.ts` (read it — call `this.artifacts.listMetadata(projectId)`, keep the highest-`revision` entry per `name`), but return it as `ArtifactReference[]` (`{name, revision, sha256}`, from `@agent-foundry/contracts`) instead of the pause snapshot's hash-map shape.

Tests: `packages/orchestrator/src/project-version-service.test.ts`, using
simple hand-written fakes for `ProjectVersionRepository`/`WorkspaceManager`/
`ArtifactStore` (no test framework/mocking library beyond what the repo
already uses — check `preview-service.test.ts` for the fake style). Cover:
`recordFromStep` builds sequence 1 then 2 on successive calls; `revert`
produces a new version with `parentVersionId` set and never mutates the
original; `revert` when the tree already matches falls back to `head()`;
`branchFrom` produces a version with `branchName` set and doesn't move
HEAD (assert `workspaces.commit`/`restoreTree` were never called);
`compare` returns the diff; `compare`/`revert`/`branchFrom`/`setProtected`
each throw `NotFoundError` for a missing version id.

## Part 2 — hook into `packages/orchestrator/src/workflow-orchestrator.ts`

Add a new **optional, trailing** constructor parameter (matching the
existing `modelOverrides?: ModelOverrideRepository` pattern right after it):

```ts
private readonly modelOverrides?: ModelOverrideRepository,
private readonly versions?: ProjectVersionService,
```

Optional because dozens of existing tests construct `WorkflowOrchestrator`
directly without it — making it required would be an unrelated, unnecessary
breaking change to every one of those call sites.

Insertion point: inside the private method that executes an agent step
(search for `const commit = step.mutatesWorkspace`), right before
`return artifact;` at the end of that try block (after `attempt` has been
updated to `'succeeded'` with the commit recorded, and after the step's
output/audit artifacts have already been `put` — so the artifact snapshot
picks them up):

```ts
if (commit && this.versions) {
  await this.versions.recordFromStep({
    projectId: project.id,
    runId,
    stepRunId: stepRun.id,
    attemptId: attempt.id,
    commit,
  });
}
return artifact;
```

Test: one new test in `packages/orchestrator/src/workflow-orchestrator.test.ts`
(or the closest existing orchestrator run-through test file — check what
already exists there) proving a mutating step produces exactly one
`ProjectVersion` via a fake `ProjectVersionService`/injected `versions`
recorder, and that a non-mutating step (or one where `commit` is `null`)
produces none. Also add the three new `WorkspaceManager` methods to any
`FakeWorkspaces`/workspace test double this test file already defines
locally (the shared one in `packages/orchestrator/src/testing/harness.ts`
already has them — only fix local duplicates if this file has its own).

## Part 3 — wire into `packages/composition/src/runtime.ts`

Construct a `FileProjectVersionRepository` (from `@agent-foundry/persistence`
— it's a sibling task's file; import it, the interface is already fixed by
the port) and a `ProjectVersionService`, pass the service as
`WorkflowOrchestrator`'s new trailing argument, and export both
`projectVersions` (the repository) and `projectVersionService` (the
service) from the object `buildRuntime` returns (same place `previewService`
etc. are added, near the bottom). A later task needs
`runtime.projectVersionService` to build API routes.

## Verify before reporting

```
npx vitest run packages/orchestrator/src/project-version-service.test.ts packages/orchestrator/src/workflow-orchestrator.test.ts
cd packages/orchestrator && npm run typecheck
```
`packages/composition` will not fully typecheck until the sibling
persistence task lands `FileProjectVersionRepository` — that's expected and
not your task's fault; note it as a concern in your report rather than
blocking on it. Do not touch `packages/persistence` yourself.

## Report

Write your report to `.superpowers/sdd/task-B-report.md`: status, commit
sha(s), one-line test summary, and any concerns (including the expected
composition typecheck gap above). Commit your work with a
conventional-commit message before reporting DONE.
