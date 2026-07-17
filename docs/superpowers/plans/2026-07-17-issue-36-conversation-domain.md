# Issue #36 Conversation Domain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `superpowers:subagent-driven-development` task-by-task, `superpowers:test-driven-development` for every behavior change, Ponytail Ultra, and `karpathy-guidelines`.

**Goal:** Implement persistent, ordered, secret-safe Conversation, Message, Attachment, and Operation models for issue #36, then deliver one reviewed PR with evidence.

**Architecture:** Use one conversation aggregate per project, backed by the existing filesystem/JSONL patterns. A single domain repository port and concrete conversation service provide append-only messages, attachment metadata, idempotent operations, pagination, SSE replay, and project export without adding dependencies or building the later chat classifier/UI.

**Tech Stack:** TypeScript, Zod, Fastify, Vitest, filesystem persistence, existing redaction utilities.

## Global Constraints

- Branch `agent/issue-36-conversation-domain` in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-36-conversation-domain`, based on freshly fetched `origin/main`.
- No new dependency, database, upload UI, authentication system, or speculative operation lifecycle.
- One canonical conversation per project; existing projects derive it lazily without migration.
- Redact message content and attachment names before persistence.
- Attachment authorization is project ownership; cross-project references fail validation.
- Message order uses an atomically assigned positive `sequence`; pagination and SSE cursors are sequence numbers.
- Operation retries with the same idempotency key and payload return the original Operation; key reuse with different data returns HTTP 409.
- Every production change follows verified RED → GREEN → refactor.

---

### Task 1: Contracts and HTTP schemas

**Files:**

- Create: `packages/contracts/src/conversation.ts`
- Create: `packages/contracts/src/conversation.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/api.test.ts`

**Interfaces:**

- Produce `MessageRole = 'user' | 'assistant' | 'system' | 'tool'`.
- Produce text, data, and attachment `MessageContentBlock` variants.
- Produce `AttachmentKind = 'file' | 'image'`.
- Produce `OperationKind = 'plan' | 'build' | 'explain' | 'repair' | 'visual-edit'`.
- Produce schemas and types for Conversation, Message, Attachment, Operation, create requests/responses, conversation pages, and project export.

- [ ] **Step 1: Write failing schema tests**

Cover all roles, content variants, operation kinds and links, attachment hash/size/access, request schemas, and export/page responses.

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/contracts/src/conversation.test.ts packages/contracts/src/api.test.ts
```

Expected: FAIL because conversation schemas and exports do not exist.

- [ ] **Step 3: Implement the minimum contracts**

Create the schemas/types above, use existing `JsonValueSchema`, `PathSegmentSchema`, `IdempotencyKeySchema`, and `ArtifactReferenceSchema`, and export them.

- [ ] **Step 4: Verify GREEN**

Run the focused tests and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat(contracts): define conversation aggregate"
```

---

### Task 2: Persistence, ordering, authorization, and idempotency

**Files:**

- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/domain/src/errors.ts`
- Create: `packages/persistence/src/conversation-repository.ts`
- Create: `packages/persistence/src/conversation-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Create: `packages/orchestrator/src/conversation-service.ts`
- Create: `packages/orchestrator/src/conversation-service.test.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Produce one `ConversationRepository` port for create/get conversation, append/list messages, create/get/list attachments, and idempotent create/list operations.
- Produce `IdempotencyConflictError`.
- Produce a concrete `ConversationService` that checks project ownership and composes the repository with the existing project/run/artifact ports.
- Add `conversations` and `conversationService` to `Runtime`.

- [ ] **Step 1: Write failing persistence/service tests**

Prove concurrent contiguous sequences, stable pagination, project-scoped attachments, duplicate Operation collapse, conflicting idempotency rejection, write-time redaction, and reconstruction from the same data directory.

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/persistence/src/conversation-repository.test.ts packages/orchestrator/src/conversation-service.test.ts
```

Expected: FAIL because repository/service exports do not exist.

- [ ] **Step 3: Implement the minimum persisted aggregate**

Store `conversation.json`, `messages.jsonl`, `attachments.jsonl`, and `operations.jsonl` under `DATA_DIR/projects/<projectId>/conversation/`. Reuse existing filesystem helpers and one directory lock per append/idempotency critical section. Use one full-file scan and a `ponytail:` comment naming an index as the upgrade path.

- [ ] **Step 4: Verify GREEN**

Run focused tests, composition integration tests, and `npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/persistence packages/orchestrator packages/composition
git commit -m "feat(persistence): store ordered conversations"
```

---

### Task 3: API, SSE replay, and secret-safe export

**Files:**

- Modify: `apps/api/src/app.ts`
- Create: `apps/api/src/conversation.test.ts`
- Modify: `apps/api/src/events-stream.test.ts`

**Interfaces:**

- Produce `GET /projects/:projectId/conversation?limit=50&cursor=<sequence>`.
- Produce attachment, message, and message-operation POST routes.
- Produce `GET /projects/:projectId/conversation/stream?cursor=<sequence>` with `Last-Event-ID` support.
- Produce `GET /projects/:projectId/export`.
- Return HTTP 409 for `IdempotencyConflictError`.

- [ ] **Step 1: Write failing API and SSE tests**

Cover creation, validation, cross-project denial, pagination, concurrent retries, 409 conflicts, complete export, redaction, disconnect/reconnect, and preservation of existing project-event SSE behavior.

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- apps/api/src/conversation.test.ts apps/api/src/events-stream.test.ts
```

Expected: FAIL because conversation routes do not exist.

- [ ] **Step 3: Implement the minimum routes**

Delegate to `ConversationService`. Use one small local SSE lifecycle helper shared by project events and conversation messages.

- [ ] **Step 4: Verify GREEN**

Run focused API tests, `npm run typecheck`, and `npm run build`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat(api): expose persistent conversations"
```

---

### Task 4: Documentation and deterministic evidence

**Files:**

- Create: `docs/adr/0019-conversation-domain.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/VALIDATION.md`

**Interfaces:**

- Document filesystem layout, sequence cursor, idempotency conflicts, project-scoped access, write-time redaction, migration compatibility, and rollback.
- Explicitly defer attachment blobs/UI to #43 and classifier/execution lifecycle to #38/#39.

- [ ] **Step 1: Document the durable decision and operator behavior**

- [ ] **Step 2: Run the full gate**

```bash
npm run check
npm run doctor
git diff --check
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: document conversation persistence"
```
