# ADR 0080: Run Candidates own isolated Supabase stacks

- Status: Accepted
- Date: 2026-08-19
- Owners: Core, Platform, Safety
- Builds on: ADR 0079

## Context

ADR 0079 keeps a run's commits off the primary branch until Local Acceptance. The current Supabase runtime, however, owns one environment per project. Candidate migrations and verification can therefore change the project's database even when the operator later rejects the candidate. Protecting Git while mutating accepted data would make rejection and recovery dishonest.

V1 creates new applications only. It does not need to clone production-like data for follow-up feature development, but it must keep pre-acceptance state separate and preserve rejected work without destructive rollback.

## Decision

Each Run Candidate owns one Candidate Supabase Stack, identified independently from the project and shared by all of that candidate's Task Agent worktrees. Candidate migrations, API integration tests, browser verification, Preview Sessions, and Verification Data use only this stack. An existing Local Supabase Stack remains untouched. Preview UI labels all candidate data as disposable.

A new project has no Local Supabase Stack before its first Local Acceptance. Before final verification, Agent Foundry resets the Candidate Supabase Stack from the exact candidate migrations, applies only configuration or domain seed data required by the approved PRD, creates Verification Data, runs acceptance, and removes that data. All earlier preview records and accounts are discarded. Acceptance then binds the exact candidate commit and clean Candidate Supabase Stack identity through one durable promotion record, fast-forwards the primary branch, and reclassifies that environment as the application's Local Supabase Stack. Crash recovery completes or reports the recorded promotion; it never starts an application with a mismatched commit and environment.

Rejection, failure, or cancellation stops but preserves the Candidate Supabase Stack with the Preserved Draft. A Final Repair Pass reuses the same candidate and stack. Deletion is separate, names both branch and environment targets, and requires confirmation; no rollback, reset, or automatic volume cleanup substitutes for preservation.

Preserved candidate environments have no automatic retention deletion. Advanced mode shows each stopped stack's disk usage and current free disk so the operator can choose explicit cleanup. Disk pressure may block new provisioning with a deterministic diagnosis but never authorizes deletion.

An Externally Modified Project uses a separate Manual Preview Stack created empty from the modified source's migrations. It never reaches the Local Supabase Stack, Candidate Supabase Stack, Local Acceptance, or Cloud Publication. Its data is disposable; the environment is recreated when the migration digest changes and has no persistence guarantee beyond that preview identity.

Provisioning, reset, Verification Data cleanup, promotion, backup, and restore use a Stack Administration Capability scoped to the named stack and one operation. Agent Foundry records operation type, target identity, start, outcome, and request ID without persisting the capability value, and revokes or discards it on completion, failure, or cancellation.

Verification Data must be removed before Local Acceptance. Cleanup failure blocks acceptance, identifies the remaining records or accounts, preserves evidence, and permits a deterministic cleanup retry without a model call.

V1 does not start a new Task Agent run against an already accepted Generated Application. Data cloning or migration from an existing Local Supabase Stack into a new candidate belongs to the later application-evolution milestone.

## Alternatives considered

- **One mutable stack per project.** Rejected because candidate migrations escape the same acceptance boundary that protects source.
- **Restore a backup after rejection.** Rejected because automatic restore is destructive, can lose concurrent local data, and contradicts forward-only recovery.
- **Delete every rejected stack.** Rejected because it destroys the database evidence needed to inspect or repair a Preserved Draft.
- **Build accepted-application cloning now.** Deferred because first-milestone generation starts from an empty project and does not need that machinery.
- **Preview manual edits against accepted data.** Rejected because unaccepted migrations or code could corrupt the one environment Local Acceptance is meant to protect.

## Consequences

Environment identity, ports, scoped administration, preview routing, migration history, backup manifests, and lifecycle operations must be candidate-aware instead of keyed only by project. Preserved Drafts may consume disk until explicit deletion, so the UI must show their stopped environment and size. Manual previews require a third, explicitly non-promotable environment class.

## Validation

Acceptance proves candidate-to-candidate, manual-preview-to-accepted, and candidate-to-accepted isolation; shared access across one candidate's worktrees; deterministic pre-acceptance reset; unchanged accepted state after rejection/failure/cancellation; durable commit-plus-environment promotion recovery; preserved candidate volumes and disk visibility; scoped administration and revocation; explicit deletion; and blocking Verification Data cleanup.
