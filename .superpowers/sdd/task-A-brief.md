# Task A: ProjectVersion persistence + WorkspaceManager git primitives

## Where this fits

Issue #40 adds a `ProjectVersion` history ledger on top of the existing git
checkpoint/commit machinery. The contract (`ProjectVersionSchema`) and the
domain ports already exist on this branch (foundation commit). Your job is
the file-backed implementation of both new ports.

## Part 1 — `packages/persistence/src/project-version-repository.ts` (new file)

Implement `FileProjectVersionRepository implements ProjectVersionRepository`
(port already defined in `packages/domain/src/ports.ts`):

```ts
export interface ProjectVersionRepository {
  create(version: ProjectVersion): Promise<void>;
  get(projectId: string, versionId: string): Promise<ProjectVersion | null>;
  list(projectId: string, limit?: number): Promise<ProjectVersion[]>;
  update(version: ProjectVersion, expectedVersion: number): Promise<ProjectVersion>;
}
```

`ProjectVersion` (full schema in `packages/contracts/src/project-version.ts`)
carries its own `sequence` (positive int, caller-assigned) and `version`
(optimistic-concurrency counter, starts at 1). This mirrors the existing
`ProjectRepository` pattern almost exactly — read
`packages/persistence/src/project-repository.ts` first, it is your closest
template (same `dataDir`, `safeSegment`, `withDirectoryLock`,
`atomicWriteJson`, `readJsonOrNull` helpers from `./fs-utils.js`, same
`VersionConflictError` from `@agent-foundry/domain` on CAS mismatch).

Differences from `ProjectRepository`:
- Storage path: `DATA_DIR/projects/<projectId>/versions/<versionId>.json`
  (sibling to the existing `DATA_DIR/projects/<projectId>/project.json`).
- `create` validates with `ProjectVersionSchema.parse`, requires
  `version === 1` (first write), and rejects if a file already exists at
  that path (same "already exists" guard as `ProjectRepository.create`).
  Do NOT build a sequence-reservation-file mechanism (contrast with
  `packages/persistence/src/model-override-repository.ts`) — the caller
  (a different task, already-agreed design) assigns `sequence` by reading
  the latest version, the same way `StepAttempt.sequence` is assigned
  elsewhere in this codebase today. Single-writer-per-project is an
  accepted, already-established assumption here, not something to fix.
- `update` is the one addition beyond `ProjectRepository`'s shape: besides
  the standard CAS check (`VersionConflictError` on mismatch, `version + 1`
  on success), it MUST reject (throw a plain `Error`) if any field other
  than `protected` or `version` differs from the currently-stored record.
  `ProjectVersion` is an immutable ledger — toggling `protected` is the only
  legal mutation. Write a test proving a `create`d version's `commit`/`kind`/
  etc. cannot be changed via `update`.
- `list(projectId, limit = 50)`: read the `versions/` directory, parse every
  file, sort by `sequence` descending (not `createdAt` — `sequence` is the
  authoritative order), slice to `limit`.

Tests: `packages/persistence/src/project-version-repository.test.ts`,
colocated, same style as `project-repository.test.ts` — create/get/list,
duplicate-create rejection, concurrent-update (stale `expectedVersion`)
rejection, and the immutable-field-on-update rejection above.

## Part 2 — extend `packages/persistence/src/workspace-manager.ts`

`FileWorkspaceManager` currently fails typecheck — it's missing three
methods the `WorkspaceManager` port now declares:

```ts
diff(projectId: string, fromRef: string, toRef: string): Promise<string>;
restoreTree(projectId: string, ref: string): Promise<void>;
createBranch(projectId: string, ref: string, name: string): Promise<string>;
```

Add them to the class, following the exact style of the existing methods in
that file (plain `execa('git', [...], { cwd })`, `cwd = this.workspacePath(projectId)`):

- `diff(projectId, fromRef, toRef)`: `git diff fromRef toRef` in the
  workspace, return `stdout` (do not throw on a non-empty diff — `execa`
  only throws on a non-zero exit code, and `git diff` exits 0 whether or
  not there are differences, so no special handling needed).
- `restoreTree(projectId, ref)`: `git checkout ref -- .` — this must NOT
  move HEAD and must NOT commit; it only stages the old tree's files into
  the working copy so the caller can commit separately (that's a different
  task's job — do not add a commit call here).
- `createBranch(projectId, ref, name)`: sanitize `name` the same way
  `preserveDraft` sanitizes `runId` (`safeSegment(name)` — read
  `preserveDraft` in the same file for the exact pattern), run
  `git branch <sanitizedName> ref`, then return `ref`'s commit sha via
  `git rev-parse ref`.

Tests: extend `packages/persistence/src/workspace-manager.test.ts` (same
`mkdtemp`/`FileWorkspaceManager` scratch-repo fixture already used by the
`preserveDraft` tests in that file) — one test per method: `diff` returns a
non-empty diff between two commits with different file content and an empty
diff comparing a ref to itself; `restoreTree` puts old file content back in
the working tree without moving `HEAD` (assert `head()` is unchanged
afterward); `createBranch` creates a branch pointing at an old commit
without moving the current branch (assert `head()` is unchanged, and
`git rev-parse <branchName>` in the test resolves to the old ref).

## Verify before reporting

Run (from the repo root):
```
npx vitest run packages/persistence/src/project-version-repository.test.ts packages/persistence/src/workspace-manager.test.ts
cd packages/persistence && npm run typecheck
```
Both must be clean. Do not touch any other package.

## Report

Write your report to `.superpowers/sdd/task-A-report.md`: status
(DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED), commit sha(s), one-line test
summary (files + pass count), and any concerns. Commit your work with a
conventional-commit message before reporting DONE.
