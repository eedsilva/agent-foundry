# ADR 0020: ProjectVersion as an explicit ledger over existing git primitives

- Status: Accepted
- Date: 2026-07-17
- Owners: Contracts, Domain, Persistence, Orchestrator, API

## Context

The user needs to experiment without fear: try a change, see it fail, revert without losing history, or branch an old version into a new independent line, and see what changed between two points. `WorkflowRun -> StepRun -> StepAttempt` (ADR 0010) already records a `commit` per attempt, and `WorkspaceManager` (ADR 0003) already exposes `checkpoint`/`commit`/`rollback`/`preserveDraft`/`discardDraft`. Neither gives the user a queryable, labeled history they can browse, compare, revert, or branch from.

Issue #40's acceptance criteria describe recording one version per approved `Operation`. `Operation` is the Conversation domain's entity (issue #36, developed in parallel) and does not exist yet on this branch. This ADR's recording hook is therefore run-level, not Operation-level: today's actual unit of change is a mutating workflow step's commit, in the PRD-batch pipeline. Once the Conversation domain lands, it calls the same recording API per approved Operation instead of per step; nothing here needs to change shape for that.

## Decision

`ProjectVersion` (`packages/contracts/src/project-version.ts`) is an immutable ledger entry: `kind: 'run' | 'revert' | 'branch'`, a `commit` sha, an `artifacts` snapshot (latest revision per name, same shape `workflow-orchestrator.ts`'s pause snapshot already computes), and for `revert`/`branch`, a `parentVersionId` pointing at the version it was created from. Only `protected` is ever mutated after creation, enforced at the repository layer (`FileProjectVersionRepository.update` rejects any other field changing). No cleanup/retention job exists anywhere in this codebase today, so `protected` has nothing to enforce against yet; a future GC job must check it.

`WorkspaceManager` gains three git primitives (`diff`, `restoreTree`, `createBranch`) alongside the existing ones, all thin `execa git` wrappers with no new abstraction. `restoreTree` only stages a ref's tree into the working copy; it never commits. `ProjectVersionService` composes these: `revert` calls `restoreTree` then `commit`, producing a new commit and a new version record — the reverted-from version is never touched, so history is never rewritten. `branchFrom` calls `createBranch`, which never moves HEAD, so branching never disturbs the current line of work.

Sequence numbers are assigned by reading the latest version and incrementing (`ProjectVersionService.nextSequence`), the same single-writer-per-project assumption `StepAttempt.sequence` already relies on elsewhere in this codebase. No reservation-file arbitration was built for this, matching that existing precedent rather than the heavier mechanism `FileModelOverrideRepository` uses for a different, genuinely concurrent case.

`compare` returns a raw unified `git diff` between two versions' commits; there is no semantic schema/config diff parser. The web panel colors `+`/`-` lines using the existing `diffAdded`/`diffRemoved` CSS classes. `workflow-orchestrator.ts` gains one optional, trailing constructor parameter (`versions?: ProjectVersionService`) and one hook, placed after a mutating step's output/audit artifacts are stored and its attempt is marked succeeded, so the recorded artifact snapshot includes the step's own output. The parameter is optional because dozens of existing tests construct `WorkflowOrchestrator` directly without it.

## Alternatives considered

- Recording a version per `Operation` now was rejected: `Operation` doesn't exist on this branch. Building against a type that doesn't exist yet would either block on issue #36 or require rework once it lands; the run-level hook is decoupled and forward-compatible instead.
- A dedicated schema/config diff parser was rejected as premature: nothing today needs more than a unified diff, and the UI can filter by known paths (`supabase/migrations/**`, `package.json`, `.env.example`) without server-side parsing.
- A sequence-reservation-file mechanism (mirroring `FileModelOverrideRepository`) was rejected: this app has no concurrent-writer-per-project case today, and the codebase already accepts the single-writer assumption for `StepAttempt.sequence`.
- Enforcing `protected` against an actual cleanup job was rejected: no such job exists yet anywhere in this codebase; the flag is stored so a future job has something to check, not to satisfy a mechanism that doesn't exist.

## Consequences

Every mutating step now also writes a `ProjectVersion` record; this is one more file write per step, using the same atomic-write/directory-lock primitives every other repository in `packages/persistence` already uses. Revert and branch always add commits/branches rather than mutating existing ones, so `DATA_DIR` and the workspace git history both grow monotonically — no automatic pruning exists, matching every other retention gap already documented for the local filesystem MVP (ADR 0003).

`ProjectVersionService.revert`/`branchFrom` are new user-triggered entry points into the workspace's git state, and — like every existing `WorkspaceManager` operation (`checkpoint`/`commit`/`rollback`) — they take no lock against a concurrent mutator. Previously the only mutator was the orchestrator itself, executing one project's steps sequentially; revert/branch now let a user mutate the same working tree via the API while a run is in flight, which can corrupt that run's checkpoint semantics (a `ponytail:` comment on `ProjectVersionService.revert`/`branchFrom` names this ceiling). This is accepted for now, matching this codebase's existing single-trusted-operator concurrency posture; the upgrade path is a per-project workspace lock or an active-run guard if concurrent use becomes real.

## Validation and rollback

Contract tests cover schema validation per `kind` and the immutable-field invariant. Repository tests cover create/get/list/update (including concurrent-update and immutable-field rejection) and the three new `WorkspaceManager` git primitives against a scratch repo. Service tests cover `recordFromStep` sequencing, `revert`/`branchFrom` never mutating their source version, and `NotFoundError` for missing ids. One orchestrator test proves the hook fires exactly once per mutating step and never for a non-mutating one. `ProjectVersionRepository` is create-only except for the `protected` toggle, so rollback is standard: stop workers, restore a pre-upgrade `DATA_DIR` snapshot. Older code ignores `DATA_DIR/projects/<projectId>/versions/`.
