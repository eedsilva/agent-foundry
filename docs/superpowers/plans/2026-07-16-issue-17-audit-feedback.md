# Issue 17 Actor Identity and Feedback Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist typed, redacted human feedback and actor identity, inject the exact feedback artifact into repair prompts, and export a deterministic run audit trail.

**Architecture:** Extend the existing approval-decision and artifact paths instead of adding a parallel feedback store. New writes use typed actors and feedback metadata, while existing `decidedBy` records remain readable. The retry directive carries the exact feedback artifact reference so replay and prompt compilation are deterministic.

**Tech Stack:** TypeScript, Zod, Vitest, Fastify, filesystem repositories, npm workspaces.

## Global Constraints

- `ActorRef` is `{ kind: 'user' | 'system' | 'worker' | 'provider', id: string, displayName?: string }`.
- Existing decisions containing only `decidedBy` remain readable without destructive migration.
- Redaction happens before approval notes or feedback artifacts reach persistent storage.
- Feedback prompt references include artifact name, revision, and SHA-256 hash.
- Audit entries are ordered by timestamp and then stable identifier.
- No new dependency or feedback-specific repository.

---

### Task 1: Actor-aware persisted feedback and audit export

**Files:**

- Modify: `packages/contracts/src/primitives.ts`, `packages/contracts/src/run.ts`, `packages/contracts/src/project.ts`, `packages/contracts/src/api.ts`, `packages/contracts/src/index.ts`
- Modify: `packages/domain/src/redaction.ts`, `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/artifact-store.ts`
- Modify: `packages/orchestrator/src/project-service.ts`, `packages/orchestrator/src/workflow-orchestrator.ts`, `packages/orchestrator/src/prompt-compiler.ts`
- Modify: `apps/api/src/app.ts`, `apps/web/app/project/[id]/page.tsx`
- Test: adjacent existing contract, redaction, persistence, orchestrator, and API test files
- Document: `docs/adr/0015-actor-feedback-audit.md`, `docs/OPERATIONS.md`, `docs/VALIDATION.md`

**Interfaces:**

- Produce `ActorRefSchema` and `ActorRef` with `kind`, `id`, and optional `displayName`.
- Produce `FeedbackArtifactSchema` with schema version, actor, approval origin, run/step relationship, redacted note, and creation time.
- Extend artifact metadata/input with optional `kind: 'feedback'`, `actor`, and `sourceDecisionId`.
- Extend retry directives with optional `feedbackArtifact: ArtifactReference`.
- Produce `RunAuditExportSchema` and `GET /runs/:runId/audit`.
- Keep `ApprovalDecision.decidedBy`; add optional typed `actor` for compatibility-on-read.
- Accept new approval API input with `actor`; continue accepting legacy `decidedBy` and normalize it to a user actor.

- [ ] **Step 1: Write failing contract and redaction tests**

Cover all four actor kinds, legacy/new approval decisions, feedback metadata, audit response parsing, nested secret keys, raw authorization/token/cookie strings, and preservation of safe text.

- [ ] **Step 2: Verify RED**

Run the focused contract and redaction test files. Expected: failures because actor, feedback, audit schemas and expanded redaction do not exist.

- [ ] **Step 3: Implement the minimum shared contracts and redaction**

Add the schemas above, export a reusable redaction function for unknown values, and keep all legacy fields readable. Do not add a new persistence abstraction.

- [ ] **Step 4: Verify GREEN for contracts and redaction**

Run the same focused tests. Expected: all pass with pristine output.

- [ ] **Step 5: Write failing persistence/orchestrator/API tests**

Prove request-changes stores one redacted feedback artifact with typed metadata and SHA-256, carries its exact reference into the retried attempt and generated request markdown, survives reconstruction with the same filesystem data, and appears in a deterministic audit export with its request and decision.

- [ ] **Step 6: Verify RED**

Run the focused persistence, approval-gate, prompt-compiler, and API tests. Expected: failures at the missing metadata, retry reference, prompt reference, restart reproduction, or audit endpoint.

- [ ] **Step 7: Implement the minimum persisted flow**

Normalize/redact the actor note before creating the decision. Reuse the existing `repairArtifact` write, enrich its typed content/metadata, store its reference on the retry directive, merge that reference into the target attempt inputs, render name/revision/hash in the request markdown, and construct the audit response by reading existing approval and artifact stores.

- [ ] **Step 8: Verify GREEN and compatibility**

Run all focused tests, then `npm run typecheck`. Expected: new and legacy paths pass.

- [ ] **Step 9: Document security, migration, rollback, and evidence**

Record why the existing stores were reused, how redaction is applied, why old decisions need no backfill, how rollback ignores optional fields, and the exact validation commands/results.

- [ ] **Step 10: Run the full gate and commit**

Run `npm run check`, `npm run doctor`, and `git diff --check`. Commit all issue-scoped files with `feat(audit): persist actor-aware feedback artifacts`.
