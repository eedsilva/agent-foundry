# ADR 0075: Local project directories have exclusive run ownership

- Status: Accepted
- Date: 2026-08-18
- Owners: Product, Core
- Supersedes: ADR 0064 only where concurrency cap 1 previously skipped task worktrees
- Superseded in part by: ADR 0079 for integration into a Run Candidate and final primary-branch promotion

## Context

Agent Foundry initially runs as a local macOS control plane and generates standalone repositories into directories chosen by the operator. Task Agents execute with the same host-user permissions as editors and other local tools. The product therefore needs one clear source owner during generation, recoverable Git boundaries, and a deliberately small first scheduling policy.

The existing task runner uses worktrees only when its concurrency cap exceeds one. Other mutating paths may use the primary checkout directly, and the product has no exclusive workspace lock. That is incompatible with the requirement that neither the operator nor a Task Agent can overwrite the other's unaccepted work.

## Decision

The operator chooses a new or empty Project Directory for each Generated Application. Non-empty directories and existing-repository import are rejected in the first milestone. Agent Foundry stores its own run metadata and immutable artifacts separately; the Standalone Repository remains usable without Agent Foundry and GitHub is optional.

Project initialization creates one baseline commit. Every mutating Task Agent, including sequential execution at concurrency one, works in its own Git worktree and branch. The primary branch changes only by serialized integration after that Vertical Task passes its declared acceptance, producing exactly one commit per accepted Vertical Task. Failed work is preserved as a Preserved Draft and never committed to the primary branch.

An Active Run Lock gives Agent Foundry exclusive mutation authority from the first mutating Task Agent until the run pauses, fails, is cancelled, or completes. During that interval the product disables its own editing actions and tells the operator not to edit the Project Directory with external tools. Because a process running as the same macOS user cannot reliably prevent another editor from writing, Agent Foundry also records the accepted Git and filesystem baseline and checks it before execution and before integration. Unexpected primary-workspace drift fails closed: integration stops, both bodies of work remain intact, and the operator receives the conflicting paths. Agent Foundry never resets or discards external edits automatically.

The operator may cancel at any time. Agent Foundry terminates the active Task Agent process tree, leaves the primary branch at its last Accepted Checkpoint, and preserves partial work as a Preserved Draft. After a control-plane restart, a run resumes automatically only from its last durable boundary and only when its PRD Revision, artifacts, configuration, and workspace baseline still match. Any mismatch pauses recovery with a drift diagnosis.

Approval waits have no timeout, consume no calls, and keep no Task Agent process active. Closing the interface does not cancel work; the local API and worker continue. After macOS sleep or restart, Agent Foundry reconciles owned process trees, terminates any orphan it can still identify, and resumes only from the last durable boundary.

Project Detachment is the default removal operation. It archives the recorded project identity and preserves its history, source, and data. Reattachment is permitted only for that exact identity and Project Directory; it is not general existing-repository import. Deleting a repository, database, storage, or Docker volume is a separate destructive operation that identifies each target and requires explicit confirmation.

The first scheduler permits one globally active mutating run, even across different projects. Each approved Task Graph targets three to eight Vertical Tasks and may contain at most ten; a larger graph must be split into another approved milestone. A rejected Task Graph or Schema Plan creates a new immutable artifact revision. The operator may edit the structured artifact directly or authorize one additional Haiku feedback call; rejection never mutates the rejected revision in place.

## Alternatives considered

- **Mutate the primary checkout directly when execution is sequential.** Rejected because concurrency one does not protect against failures, cancellation, or external editor writes.
- **Allow operator edits and merge them optimistically.** Rejected for the first milestone because ownership and acceptance become ambiguous and merge repair consumes the Economy Profile's limited calls.
- **Require GitHub.** Rejected because the Local Target and its repository must work offline after provider authentication and dependency installation.
- **Run one mutation per project concurrently.** Deferred until the single global queue has proven recovery, resource, and call-limit behavior.

## Consequences

The persistence and scheduler contracts must separate the user-selected repository path from Agent Foundry's internal `DATA_DIR`, acquire a durable global mutation lease, and route every mutating task through the existing worktree lifecycle. Primary-branch drift becomes a blocking operational state rather than a merge attempt.

The repository history is simple to inspect and roll back: one baseline plus one commit per accepted Vertical Task. The tradeoff is lower throughput and a temporarily read-only source workspace while agents run. Hard OS-level write prevention is not claimed; detection and fail-closed integration are the enforceable boundary on local macOS.

## Validation and rollback

Acceptance requires tests proving that concurrent mutating runs cannot acquire the global lease, cap-one tasks still receive worktrees, rejected tasks leave the primary commit unchanged, accepted tasks add one commit, non-empty directories are rejected, and Workspace Drift blocks integration without deleting either diff. Crash and cancellation tests must prove process-tree termination, lock release or durable recovery, drift-gated resume, and Preserved Draft inspection. Detachment tests must prove that no source or data resource is deleted.

Rollback requires superseding this ADR. Removing the lock or worktree rule without another exclusive-ownership mechanism would reintroduce an unprotected shared workspace.
