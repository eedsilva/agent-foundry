# ADR 0079: Local Acceptance promotes a Run Candidate

- Status: Accepted
- Date: 2026-08-19
- Owners: Product, Core, Safety
- Supersedes: ADR 0075 where each accepted Vertical Task previously advanced the primary branch

## Context

ADR 0075 gave every mutating Task Agent a worktree and integrated each accepted task directly into the primary branch. The product also requires final human Local Acceptance. Those rules conflict: rejecting the completed application cannot protect the primary branch if task commits have already changed it.

The repository still needs inspectable one-commit-per-task history, durable recovery boundaries, and no large squash or reverse merge after rejection.

## Decision

Every mutating run creates one Run Candidate from the exact clean primary-branch baseline recorded when the Active Run Lock begins. Each Task Agent works in its own branch and worktree. After the task's declared gates pass, Agent Foundry serially integrates exactly one task commit into the Run Candidate, advancing its Accepted Checkpoint. The primary branch remains at the run baseline throughout execution.

After the Task Graph completes, deterministic and browser gates run against the Run Candidate. Haiku produces one advisory Release Assessment. It cannot accept, reject, block, or trigger repair by itself. The operator then sees the complete diff, evidence, screenshots, Release Assessment, and exact candidate commit.

Local Acceptance rechecks primary and filesystem drift, then atomically fast-forwards the primary branch to that exact Accepted Checkpoint. That commit becomes the Promotion Commit. A merge commit, squash, rebase, source rewrite, or build-time patch is not permitted during promotion.

Rejection, failure, or cancellation leaves the primary branch unchanged and preserves the Run Candidate as a Preserved Draft. The operator may authorize the one bounded Final Repair Pass defined by ADR 0073. Feedback that changes a requirement instead creates a new PRD Revision and planning lineage.

After the Active Run Lock ends, the operator may edit the Standalone Repository freely. A changed commit or dirty tree makes it an Externally Modified Project. V1 may preview those files, but it cannot accept them, turn them into a new Promotion Commit, or include them in Cloud Publication. Publication of the last Promotion Commit uses an isolated worktree at that exact commit and never resets, stashes, commits, or uploads the operator's external edits.

Normal Vertical Task completion requires no human approval. V1 pauses for operator approval only at these boundaries:

- PRD Revision;
- Task Graph Revision;
- Schema Plan Revision;
- an exception to sandbox, network, dependency, or package-lifecycle policy, except that a blocking Supply Chain Gate cannot be waived;
- final Local Acceptance;
- the exact Cloud Publication plan before provisioning, migration, or deployment; and
- each Cloud Destruction or explicit data restore.

## Alternatives considered

- **Integrate every task into primary immediately.** Rejected because final rejection would arrive after the protected branch had changed.
- **Squash the entire run at acceptance.** Rejected because it discards the accepted one-commit-per-task history used for diagnosis and bounded repair.
- **Revert primary when the operator rejects.** Rejected because rejection should not create a new history-changing operation or depend on a successful reverse patch.
- **Require human approval after every task.** Rejected because deterministic task gates already establish the checkpoint and repeated pauses add cost and operator latency without protecting final promotion better.
- **Treat manual post-run edits as accepted.** Rejected because they have no bound PRD Revision, Task Graph, verification evidence, or Local Acceptance.

## Consequences

The task runner needs a run-level integration target instead of treating the primary checkout as that target. Preview, database verification, diff calculation, recovery, and final evidence must all bind to the Run Candidate commit. Local Acceptance becomes the only normal operation that advances the primary branch during a run. Manual source remains operator-owned, while accepted-version provenance remains explicit.

## Validation

Acceptance proves one candidate commit per accepted task, unchanged primary state during execution and after rejection/failure/cancellation, drift-blocked promotion, exact fast-forward promotion after acceptance, preserved candidate recovery, advisory-only Release Assessment behavior, and no per-task approval in the normal path.
