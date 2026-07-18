# Issue #38 Chat Operations (Change Requests + Context Compiler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS: use `superpowers:subagent-driven-development`
> task-by-task, `superpowers:test-driven-development` for every behavior change, Ponytail Full, and
> `karpathy-guidelines`. Design rationale lives in
> [`docs/superpowers/specs/2026-07-18-issue-38-chat-operations-design.md`](../specs/2026-07-18-issue-38-chat-operations-design.md) —
> read it first, this plan assumes its decisions (deterministic classifier, harness fragments as
> "knowledge files", #39 owns execution/lifecycle not this issue).

**Goal:** Turn a chat message into a classified, correctable `ChangeRequest` and a bounded,
reference-carrying context digest, so Plan/Build (and explain/repair/visual-edit) operations are
built from more than just the raw current message, with reproducible classification and full
prompt provenance.

**Architecture:** Two new pure/deterministic modules (`message-classifier.ts`,
`context-compiler.ts`) with zero I/O, wired through two new `OperationService` methods
(`classify`/`decideChangeRequest`) and one small `ConversationOperationRunner` extension that loads
the operation's `ChangeRequest` + project history + recent versions, compiles a digest, embeds it in
the compiled prompt, and records provenance (messages, prior decisions, versions, harness fragments)
back onto the `ChangeRequest`. New `ChangeRequest` records live in the same
`DATA_DIR/projects/<projectId>/conversation/` directory as `Operation`, following the exact same
JSONL + directory-lock persistence pattern.

**Tech Stack:** TypeScript, Zod, Fastify, Vitest, filesystem persistence (existing patterns only —
no new dependency).

## Global Constraints

- Work in worktree `/Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-38-change-requests`
  on branch `worktree-issue-38-change-requests`, already merged onto a fixed `origin/main` baseline
  (includes the `worktree-fix-ci-executor-fake` CI fix — verify `npm run typecheck` is clean before
  starting Task 1).
- No new npm dependency. No LLM/agent round-trip for classification — pure TypeScript rules only
  (see design doc's "Classifier: deterministic, not LLM-driven").
- No changes to `ConversationOperationRunner`'s execution mechanics (route → compile → execute →
  persist artifact) — only what feeds the compiled instructions and what gets recorded about that
  compilation. Operation execution/lifecycle changes are explicitly out of scope (#39 per
  `docs/ARCHITECTURE.md`).
- The existing manual Plan/Build toggle path (`OperationService.start()` called directly without a
  `changeRequestId`) must keep working unchanged — every new behavior is additive and gated on
  `changeRequestId`/`ChangeRequest` presence.
- `Build` (and every other kind) is only ever turned into an `Operation` through
  `OperationService.decideChangeRequest()`'s `'confirm'` action once this plan lands — never
  automatically from `classify()`.
- Compaction must never drop a confirmed or proposed `ChangeRequest`'s id from a compiled digest's
  `sources` — only reduce its detail level. Every task touching `context-compiler.ts` must keep this
  invariant covered by a test that asserts `sources` set-membership, not just digest text content.
- Every production change follows verified RED → GREEN → refactor.
- Run `npm run typecheck` and the affected package's focused test command after every task; run the
  full `npm run check` after the last task.

---

### Task 1: `ChangeRequest` contracts and API request/response schemas

**Files:**

- Create: `packages/contracts/src/change-request.ts`
- Create: `packages/contracts/src/change-request.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/api.test.ts`

**Interfaces:**

- Produce `ChangeRequestStatus = 'proposed' | 'confirmed' | 'rejected'`.
- Produce `ContextSource = { type: 'message' | 'change-request' | 'project-version' | 'harness-fragment'; id: string }`.
- Produce `ChangeRequest` (see full shape in Step 3 below) and `ChangeRequestSchema`.
- Produce `StartOperationRequestSchema` gains optional `changeRequestId`.
- Produce `ClassifyMessageResponseSchema` → `{ changeRequest: ChangeRequest }`.
- Produce `DecideChangeRequestRequestSchema` → discriminated union on `action`:
  `{ action: 'reject' }` or `{ action: 'confirm'; kind: OperationKind; planOperationId?: string; directExecution?: boolean }`,
  with the existing `requireExactlyOnePlanSource` refine applied when `kind === 'build'`.
- Produce `DecideChangeRequestResponseSchema` → `{ changeRequest: ChangeRequest; operation?: Operation }`.

- [ ] **Step 1: Write failing schema tests**

Append to `packages/contracts/src/change-request.test.ts` (new file):

```ts
import { describe, expect, it } from 'vitest';
import { ChangeRequestSchema, ContextSourceSchema } from './change-request.js';

const BASE = {
  id: 'cr-1',
  projectId: 'project-1',
  conversationId: 'project-1',
  messageId: 'message-1',
  suggestedKind: 'build' as const,
  summary: 'Add a login page with email and password.',
  rationale: 'Message uses an imperative verb requesting a workspace change.',
  status: 'proposed' as const,
  createdAt: '2026-07-18T00:00:00.000Z',
};

describe('ChangeRequestSchema', () => {
  it('parses a minimal proposed change request', () => {
    const parsed = ChangeRequestSchema.parse(BASE);
    expect(parsed.referencedDecisionIds).toEqual([]);
    expect(parsed.contextSources).toEqual([]);
    expect(parsed.confirmedKind).toBeUndefined();
  });

  it('parses a confirmed change request with sources and a decision reference', () => {
    const parsed = ChangeRequestSchema.parse({
      ...BASE,
      status: 'confirmed',
      confirmedKind: 'build',
      referencedDecisionIds: ['cr-0'],
      contextSources: [{ type: 'change-request', id: 'cr-0' }],
      operationId: 'operation-1',
      decidedAt: '2026-07-18T00:05:00.000Z',
    });
    expect(parsed.contextSources).toEqual([{ type: 'change-request', id: 'cr-0' }]);
  });

  it('rejects an unknown field', () => {
    expect(() => ChangeRequestSchema.parse({ ...BASE, extra: 'nope' })).toThrow();
  });

  it('rejects an unknown context source type', () => {
    expect(() => ContextSourceSchema.parse({ type: 'file', id: 'x' })).toThrow();
  });
});
```

Append to `packages/contracts/src/api.test.ts` (existing file — add a new `describe` block, follow
the file's existing import/style conventions):

```ts
import { DecideChangeRequestRequestSchema, StartOperationRequestSchema } from './api.js';

describe('StartOperationRequestSchema', () => {
  it('accepts an optional changeRequestId', () => {
    const parsed = StartOperationRequestSchema.parse({
      kind: 'plan',
      changeRequestId: 'cr-1',
    });
    expect(parsed.changeRequestId).toBe('cr-1');
  });
});

describe('DecideChangeRequestRequestSchema', () => {
  it('accepts a reject action with no kind', () => {
    expect(DecideChangeRequestRequestSchema.parse({ action: 'reject' })).toEqual({
      action: 'reject',
    });
  });

  it('accepts a confirm action for a non-build kind with no plan fields', () => {
    const parsed = DecideChangeRequestRequestSchema.parse({ action: 'confirm', kind: 'plan' });
    expect(parsed).toEqual({ action: 'confirm', kind: 'plan' });
  });

  it('requires exactly one of planOperationId/directExecution when confirming a build', () => {
    expect(() =>
      DecideChangeRequestRequestSchema.parse({ action: 'confirm', kind: 'build' }),
    ).toThrow();
    expect(() =>
      DecideChangeRequestRequestSchema.parse({
        action: 'confirm',
        kind: 'build',
        directExecution: true,
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/contracts/src/change-request.test.ts packages/contracts/src/api.test.ts
```

Expected: FAIL — `change-request.ts` doesn't exist yet, `StartOperationRequestSchema` rejects
`changeRequestId` (strict), `DecideChangeRequestRequestSchema` doesn't exist.

- [ ] **Step 3: Implement the minimum contracts**

Create `packages/contracts/src/change-request.ts`:

```ts
import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { OperationKindSchema } from './conversation.js';

export const ChangeRequestStatusSchema = z.enum(['proposed', 'confirmed', 'rejected']);
export type ChangeRequestStatus = z.infer<typeof ChangeRequestStatusSchema>;

export const ContextSourceSchema = z
  .object({
    type: z.enum(['message', 'change-request', 'project-version', 'harness-fragment']),
    id: z.string().min(1),
  })
  .strict();
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const ChangeRequestSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    messageId: PathSegmentSchema,
    suggestedKind: OperationKindSchema,
    confirmedKind: OperationKindSchema.optional(),
    summary: z.string().min(1),
    rationale: z.string().min(1),
    referencedDecisionIds: z.array(PathSegmentSchema).default([]),
    contextSources: z.array(ContextSourceSchema).default([]),
    status: ChangeRequestStatusSchema,
    operationId: PathSegmentSchema.optional(),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().optional(),
  })
  .strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;
```

Modify `packages/contracts/src/index.ts` — add after the existing `conversation.js` line:

```ts
export * from './conversation.js';
export * from './change-request.js';
```

Modify `packages/contracts/src/api.ts`:

1. Add `ChangeRequestSchema` to the import from `./change-request.js` (new import line, placed after
   the existing `./conversation.js` import block):

```ts
import { ChangeRequestSchema } from './change-request.js';
```

2. Extend `StartOperationRequestSchema` (find the existing block — add `changeRequestId`):

```ts
export const StartOperationRequestSchema = z
  .object({
    kind: z.enum(['plan', 'build']),
    planOperationId: PathSegmentSchema.optional(),
    directExecution: z.boolean().optional(),
    changeRequestId: PathSegmentSchema.optional(),
  })
  .strict()
  .superRefine(requireExactlyOnePlanSource);
export type StartOperationRequest = z.infer<typeof StartOperationRequestSchema>;
```

3. Add after the existing `DecideOperationRequestSchema`/`type DecideOperationRequest` block:

```ts
export const ClassifyMessageResponseSchema = z.object({ changeRequest: ChangeRequestSchema }).strict();
export type ClassifyMessageResponse = z.infer<typeof ClassifyMessageResponseSchema>;

export const DecideChangeRequestRequestSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('reject') }).strict(),
    z
      .object({
        action: z.literal('confirm'),
        kind: OperationKindSchema,
        planOperationId: PathSegmentSchema.optional(),
        directExecution: z.boolean().optional(),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.action !== 'confirm' || input.kind !== 'build') return;
    requireExactlyOnePlanSource(input, ctx);
  });
export type DecideChangeRequestRequest = z.infer<typeof DecideChangeRequestRequestSchema>;

export const DecideChangeRequestResponseSchema = z
  .object({ changeRequest: ChangeRequestSchema, operation: OperationSchema.optional() })
  .strict();
export type DecideChangeRequestResponse = z.infer<typeof DecideChangeRequestResponseSchema>;
```

`OperationKindSchema` is already imported in `api.ts` from `./conversation.js` — confirm it's in that
existing import list; if not, add it there rather than re-importing from `change-request.js`.

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/contracts/src/change-request.test.ts packages/contracts/src/api.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): define ChangeRequest and classify/decide API schemas"
```

---

### Task 2: `ChangeRequest` persistence and a shared in-memory test fake

**Files:**

- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/conversation-repository.ts`
- Modify: `packages/persistence/src/conversation-repository.test.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/operation-service.test.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts`

**Interfaces:**

- Consumes: `ChangeRequest`, `ChangeRequestSchema` (Task 1).
- Produces: `ConversationRepository.createChangeRequest/getChangeRequest/updateChangeRequest/listChangeRequests`,
  `ConversationSnapshot.changeRequests: ChangeRequest[]`, `FileConversationRepository` support for
  the same, and a shared `export class MemoryConversations implements ConversationRepository` in
  `testing/harness.ts` that both existing test files switch to (deleting their local duplicates).

- [ ] **Step 1: Write failing persistence tests**

This file's real pattern (already read in full — no `makeRepo()` helper exists): a module-level
`temporaryDataDir()` helper returning a fresh temp path per test, a fixed `conversation` const
(`{ id: 'project-1', projectId: 'project-1', createdAt }`), and per-entity fixture factories like
`operation(overrides)`. Add a matching `changeRequest(overrides)` factory right after the existing
`operation()` factory (existing lines ~46-58):

```ts
function changeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'cr-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    suggestedKind: 'build',
    summary: 'Add a login page.',
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'proposed',
    createdAt,
    ...overrides,
  };
}
```

Add `ChangeRequest` to this file's existing `@agent-foundry/contracts` type import. Then add a new
`describe` block, following the exact `temporaryDataDir()` + inline `new FileConversationRepository(dataDir)`
idiom the rest of the file already uses:

```ts
describe('FileConversationRepository change requests', () => {
  it('creates, lists, and updates a change request scoped to its project', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    await repository.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt,
    });
    const created = await repository.createChangeRequest(changeRequest());
    expect(await repository.getChangeRequest('project-1', created.id)).toEqual(created);
    expect(await repository.listChangeRequests('project-1')).toEqual([created]);

    const updated = await repository.updateChangeRequest({
      ...created,
      status: 'confirmed',
      confirmedKind: 'build',
      decidedAt: '2026-07-17T12:01:00.000Z',
    });
    expect((await repository.getChangeRequest('project-1', created.id))?.status).toBe('confirmed');
    expect(updated.confirmedKind).toBe('build');
  });

  it('returns null for a change request id from a different project', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    await repository.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt,
    });
    await repository.createChangeRequest(changeRequest());
    expect(await repository.getChangeRequest('project-2', 'cr-1')).toBeNull();
  });

  it('includes change requests in getSnapshot', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    await repository.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt,
    });
    await repository.createChangeRequest(changeRequest());
    const snapshot = await repository.getSnapshot('project-1');
    expect(snapshot.changeRequests).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/persistence/src/conversation-repository.test.ts
```

Expected: FAIL — `createChangeRequest` etc. don't exist on `ConversationRepository`/
`FileConversationRepository`.

- [ ] **Step 3: Implement the minimum persisted support**

Modify `packages/domain/src/ports.ts` — extend the existing `ConversationRepository` interface (find
its current location, ~line 54) and `ConversationSnapshot`:

```ts
export interface ConversationRepository {
  createConversation(conversation: Conversation): Promise<void>;
  getConversation(projectId: string): Promise<Conversation | null>;
  getSnapshot(projectId: string): Promise<ConversationSnapshot>;
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message>;
  listMessages(
    projectId: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<Message[]>;
  createAttachment(attachment: Attachment): Promise<Attachment>;
  getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null>;
  listAttachments(projectId: string): Promise<Attachment[]>;
  createOperation(operation: Operation): Promise<Operation>;
  getOperation(projectId: string, operationId: string): Promise<Operation | null>;
  updateOperation(operation: Operation): Promise<Operation>;
  listOperations(projectId: string): Promise<Operation[]>;
  createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest>;
  getChangeRequest(projectId: string, changeRequestId: string): Promise<ChangeRequest | null>;
  updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest>;
  listChangeRequests(projectId: string): Promise<ChangeRequest[]>;
}

export interface ConversationSnapshot {
  conversation: Conversation | null;
  messages: Message[];
  attachments: Attachment[];
  operations: Operation[];
  changeRequests: ChangeRequest[];
}
```

Add `ChangeRequest` to `ports.ts`'s existing `@agent-foundry/contracts` type-only import list.

Modify `packages/persistence/src/conversation-repository.ts` — this file's real structure (already
read in full): each entity has a private `readXxx()` parser and a private `xxxPath()` joiner, built
on the file's own `readJsonLines`/`atomicWriteText`(via `this.writeText`)/`withLock`/`rootFor`/
`safeSegment` imports from `./fs-utils.js`. Add a parallel `changeRequests.jsonl` block using the
exact same shape as the existing `operations.jsonl` block (`createOperation`/`getOperation`/
`updateOperation`/`listOperations`/`readOperations`/`operationsPath`, all at their current lines
141-181 and 203-207 and 237-239):

1. Add `ChangeRequest, ChangeRequestSchema` to the existing `@agent-foundry/contracts` import block
   (top of file, alongside `AttachmentSchema, ConversationSchema, MessageSchema, OperationSchema`).

2. Add these methods to the class, placed after `listOperations` (existing line 181) and before the
   private `requireConversation` helper (existing line 183):

```ts
  async createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.withLock(parsed.projectId, async () => {
      await this.requireConversation(parsed.projectId, parsed.conversationId);
      const existing = await this.readChangeRequests(parsed.projectId);
      if (existing.some((item) => item.id === parsed.id)) {
        throw new Error(`Change request ${parsed.id} already exists`);
      }
      await this.writeJsonLines(this.changeRequestsPath(parsed.projectId), [...existing, parsed]);
      return parsed;
    });
  }

  async getChangeRequest(projectId: string, changeRequestId: string): Promise<ChangeRequest | null> {
    return (
      (await this.readChangeRequests(projectId)).find((item) => item.id === changeRequestId) ?? null
    );
  }

  async updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.withLock(parsed.projectId, async () => {
      const changeRequests = await this.readChangeRequests(parsed.projectId);
      const index = changeRequests.findIndex((item) => item.id === parsed.id);
      if (index === -1) throw new NotFoundError(`Change request ${parsed.id} not found`);
      changeRequests[index] = parsed;
      await this.writeJsonLines(this.changeRequestsPath(parsed.projectId), changeRequests);
      return parsed;
    });
  }

  async listChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    return this.readChangeRequests(projectId);
  }
```

3. Add the matching private reader and path helper alongside the existing `readOperations`/
   `operationsPath` (existing lines 203-207 and 237-239):

```ts
  private async readChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    return (await readJsonLines<unknown>(this.changeRequestsPath(projectId))).map((value) =>
      ChangeRequestSchema.parse(value),
    );
  }
```

```ts
  private changeRequestsPath(projectId: string): string {
    return join(this.rootFor(projectId), 'changeRequests.jsonl');
  }
```

4. Update both of `getSnapshot()`'s return sites (existing lines 62-73) to include
   `changeRequests`:

```ts
  async getSnapshot(projectId: string): Promise<ConversationSnapshot> {
    const safeProjectId = safeSegment(projectId);
    if (!(await exists(this.rootFor(safeProjectId)))) {
      return { conversation: null, messages: [], attachments: [], operations: [], changeRequests: [] };
    }
    return this.withLock(safeProjectId, async () => ({
      conversation: await this.getConversation(safeProjectId),
      messages: await this.readMessages(safeProjectId),
      attachments: await this.readAttachments(safeProjectId),
      operations: await this.readOperations(safeProjectId),
      changeRequests: await this.readChangeRequests(safeProjectId),
    }));
  }
```

Modify `packages/orchestrator/src/testing/harness.ts` — add a shared fake (place it near other
`InMemory*` classes, e.g. after `InMemoryEvents`):

```ts
export class MemoryConversations implements ConversationRepository {
  private conversation: Conversation | undefined;
  readonly messages: Message[] = [];
  readonly attachments: Attachment[] = [];
  readonly operations: Operation[] = [];
  readonly changeRequests: ChangeRequest[] = [];

  createConversation(conversation: Conversation): Promise<void> {
    this.conversation = conversation;
    return Promise.resolve();
  }
  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(
      this.conversation && this.conversation.projectId === projectId ? this.conversation : null,
    );
  }
  getSnapshot(projectId: string): Promise<ConversationSnapshot> {
    return Promise.resolve({
      conversation: this.conversation && this.conversation.projectId === projectId ? this.conversation : null,
      messages: this.messages.filter((m) => m.projectId === projectId),
      attachments: this.attachments.filter((a) => a.projectId === projectId),
      operations: this.operations.filter((o) => o.projectId === projectId),
      changeRequests: this.changeRequests.filter((c) => c.projectId === projectId),
    });
  }
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const sequence = this.messages.filter((m) => m.projectId === message.projectId).length + 1;
    const stored: Message = { ...message, sequence };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }
  listMessages(
    projectId: string,
    options?: { cursor?: number; limit?: number },
  ): Promise<Message[]> {
    const cursor = options?.cursor ?? 0;
    const limit = options?.limit;
    const filtered = this.messages
      .filter((m) => m.projectId === projectId && m.sequence > cursor)
      .sort((a, b) => a.sequence - b.sequence);
    return Promise.resolve(limit ? filtered.slice(0, limit) : filtered);
  }
  createAttachment(attachment: Attachment): Promise<Attachment> {
    this.attachments.push(attachment);
    return Promise.resolve(attachment);
  }
  getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null> {
    return Promise.resolve(
      this.attachments.find((a) => a.projectId === projectId && a.id === attachmentId) ?? null,
    );
  }
  listAttachments(projectId: string): Promise<Attachment[]> {
    return Promise.resolve(this.attachments.filter((a) => a.projectId === projectId));
  }
  createOperation(operation: Operation): Promise<Operation> {
    this.operations.push(operation);
    return Promise.resolve(operation);
  }
  getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    return Promise.resolve(
      this.operations.find((o) => o.projectId === projectId && o.id === operationId) ?? null,
    );
  }
  updateOperation(operation: Operation): Promise<Operation> {
    const index = this.operations.findIndex((o) => o.id === operation.id);
    if (index === -1) throw new Error(`operation ${operation.id} missing`);
    this.operations[index] = operation;
    return Promise.resolve(operation);
  }
  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(this.operations.filter((o) => o.projectId === projectId));
  }
  createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    this.changeRequests.push(changeRequest);
    return Promise.resolve(changeRequest);
  }
  getChangeRequest(projectId: string, changeRequestId: string): Promise<ChangeRequest | null> {
    return Promise.resolve(
      this.changeRequests.find((c) => c.projectId === projectId && c.id === changeRequestId) ??
        null,
    );
  }
  updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const index = this.changeRequests.findIndex((c) => c.id === changeRequest.id);
    if (index === -1) throw new Error(`change request ${changeRequest.id} missing`);
    this.changeRequests[index] = changeRequest;
    return Promise.resolve(changeRequest);
  }
  listChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    return Promise.resolve(this.changeRequests.filter((c) => c.projectId === projectId));
  }
}
```

Add `Attachment, ChangeRequest, Conversation, ConversationSnapshot, Message, Operation` to this
file's existing type imports (from `@agent-foundry/contracts` and `@agent-foundry/domain`
respectively — split correctly: `ChangeRequest`/`Conversation`/`Message`/`Operation`/`Attachment`
from contracts, `ConversationRepository`/`ConversationSnapshot` from domain).

In `packages/orchestrator/src/operation-service.test.ts` and
`packages/orchestrator/src/conversation-operation-runner.test.ts`: delete each file's local
`class MemoryConversations implements ConversationRepository { ... }` block entirely, and add
`MemoryConversations` to each file's existing `from './testing/harness.js'` import. Do not change
any test bodies — both files' existing tests must pass unchanged against the shared fake (its
behavior is a straight port of what both local copies already did).

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/persistence/src/conversation-repository.test.ts packages/orchestrator/src/operation-service.test.ts packages/orchestrator/src/conversation-operation-runner.test.ts packages/orchestrator/src/plan-build-modes.test.ts
npm run typecheck
```

Expected: PASS — including every pre-existing test in the two files whose local fake was deleted.

- [ ] **Step 5: Commit**

```bash
git add packages/domain packages/persistence packages/orchestrator
git commit -m "feat(persistence): store ChangeRequest and share the MemoryConversations test fake"
```

---

### Task 3: `MessageClassifier` (deterministic rules)

**Files:**

- Create: `packages/orchestrator/src/message-classifier.ts`
- Create: `packages/orchestrator/src/message-classifier.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Interfaces:**

- Consumes: `Message`, `ChangeRequest`, `OperationKind` (contracts), `messageText` (already exported
  from `./conversation-step-config.js`).
- Produces:
  ```ts
  export interface ClassificationResult {
    suggestedKind: OperationKind;
    rationale: string;
    referencedDecisionIds: string[];
    summary: string;
  }
  export function classifyMessage(input: {
    message: Message;
    priorChangeRequests: ChangeRequest[];
  }): ClassificationResult;
  export function findReferencedDecisions(
    messageWords: Set<string>,
    priorChangeRequests: ChangeRequest[],
  ): string[];
  export function tokenize(text: string): string[];
  ```
  Task 4 (`context-compiler.ts`) and Task 5 (`operation-service.ts`) both import `classifyMessage`
  and `ClassificationResult` from this file by these exact names.

- [ ] **Step 1: Write failing classifier tests**

Create `packages/orchestrator/src/message-classifier.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Message } from '@agent-foundry/contracts';
import { classifyMessage, findReferencedDecisions, tokenize } from './message-classifier.js';

function textMessage(id: string, text: string): Message {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text }],
    sequence: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

function confirmedChangeRequest(id: string, summary: string): ChangeRequest {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: `${id}-message`,
    suggestedKind: 'build',
    confirmedKind: 'build',
    summary,
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'confirmed',
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('classifyMessage', () => {
  it('classifies an imperative change request as build', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Add a login page with email and password.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('build');
    expect(result.referencedDecisionIds).toEqual([]);
  });

  it('classifies a bug report as repair', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'The login button is broken, fix the crash on click.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('repair');
  });

  it('classifies a styling request as visual-edit', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Change the header color and font to match the new theme.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('visual-edit');
  });

  it('classifies a plain question with no change verb as explain', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Why does the login page redirect to the dashboard?'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('explain');
  });

  it('defaults to plan when no rule matches', () => {
    const result = classifyMessage({
      message: textMessage('m1', 'Let us think about the onboarding flow together.'),
      priorChangeRequests: [],
    });
    expect(result.suggestedKind).toBe('plan');
  });

  it('required test: a later requirement change references an earlier confirmed decision', () => {
    const priorChangeRequests = [
      confirmedChangeRequest('cr-1', 'Add a login page with email and password fields.'),
    ];
    const result = classifyMessage({
      message: textMessage(
        'm2',
        'Actually change the login page to use magic links instead of a password field.',
      ),
      priorChangeRequests,
    });
    expect(result.suggestedKind).toBe('build');
    expect(result.referencedDecisionIds).toEqual(['cr-1']);
  });

  it('does not reference a decision that shares fewer than two significant words', () => {
    const priorChangeRequests = [confirmedChangeRequest('cr-1', 'Add a footer with copyright text.')];
    const result = classifyMessage({
      message: textMessage('m2', 'Add a login page with email and password.'),
      priorChangeRequests,
    });
    expect(result.referencedDecisionIds).toEqual([]);
  });

  it('never references a proposed (not yet confirmed) change request', () => {
    const proposed: ChangeRequest = {
      ...confirmedChangeRequest('cr-1', 'Add a login page with email and password.'),
      status: 'proposed',
      confirmedKind: undefined,
    };
    const result = classifyMessage({
      message: textMessage('m2', 'Add a login page with email and password.'),
      priorChangeRequests: [proposed],
    });
    expect(result.referencedDecisionIds).toEqual([]);
  });
});

describe('tokenize', () => {
  it('lowercases, strips punctuation, and drops short/stop words', () => {
    expect(tokenize('Add a login page, please!')).toEqual(['add', 'login', 'page', 'please']);
  });
});

describe('findReferencedDecisions', () => {
  it('requires at least two shared significant words', () => {
    const oneWordOverlap = [confirmedChangeRequest('cr-1', 'Add a footer component.')];
    expect(findReferencedDecisions(new Set(['add', 'header']), oneWordOverlap)).toEqual([]);

    const twoWordOverlap = [confirmedChangeRequest('cr-1', 'Add a footer component.')];
    expect(findReferencedDecisions(new Set(['add', 'footer', 'component']), twoWordOverlap)).toEqual([
      'cr-1',
    ]);
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/orchestrator/src/message-classifier.test.ts
```

Expected: FAIL — `./message-classifier.js` doesn't exist.

- [ ] **Step 3: Write the minimal deterministic classifier**

Create `packages/orchestrator/src/message-classifier.ts`:

```ts
import type { ChangeRequest, Message, OperationKind } from '@agent-foundry/contracts';
import { messageText } from './conversation-step-config.js';

export interface ClassificationResult {
  suggestedKind: OperationKind;
  rationale: string;
  referencedDecisionIds: string[];
  summary: string;
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'have', 'has', 'was', 'were',
  'are', 'you', 'your', 'let', 'use', 'add', 'com', 'que', 'para', 'uma', 'dos', 'das',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ú\s]/gi, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));
}

function summarize(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}...` : firstLine;
}

const REPAIR_PATTERN = /\b(fix|bug|error|broken|crash|failing|conserta|corrig|quebrad|erro)\w*/i;
const VISUAL_PATTERN =
  /\b(color|colour|style|css|layout|design|font|spacing|padding|margin|theme|cor|estilo|visual)\w*/i;
const EXPLAIN_PATTERN = /\b(why|what|how|explain|explique|porque|por que|o que|como)\w*/i;
const BUILD_PATTERN =
  /\b(implement|build|add|change|update|create|remove|delete|refactor|write|generate|deploy|implementa|adiciona|muda|mudar|cria|remove|altera|refatora)\w*/i;

function classifyKind(text: string): { kind: OperationKind; rationale: string } {
  if (REPAIR_PATTERN.test(text)) {
    return { kind: 'repair', rationale: 'Message names a bug, error, or fix.' };
  }
  if (VISUAL_PATTERN.test(text)) {
    return { kind: 'visual-edit', rationale: 'Message names a visual or styling change.' };
  }
  if (EXPLAIN_PATTERN.test(text) && text.trim().endsWith('?') && !BUILD_PATTERN.test(text)) {
    return { kind: 'explain', rationale: 'Message is a question with no imperative change verb.' };
  }
  if (BUILD_PATTERN.test(text)) {
    return { kind: 'build', rationale: 'Message uses an imperative verb requesting a workspace change.' };
  }
  return { kind: 'plan', rationale: 'No clear execution verb found; defaulting to a non-mutating plan.' };
}

export function findReferencedDecisions(
  messageWords: Set<string>,
  priorChangeRequests: ChangeRequest[],
): string[] {
  const matches: string[] = [];
  for (const changeRequest of priorChangeRequests) {
    if (changeRequest.status !== 'confirmed') continue;
    const summaryWords = new Set(tokenize(changeRequest.summary));
    let overlap = 0;
    for (const word of summaryWords) {
      if (messageWords.has(word)) overlap += 1;
    }
    if (overlap >= 2) matches.push(changeRequest.id);
  }
  return matches;
}

export function classifyMessage(input: {
  message: Message;
  priorChangeRequests: ChangeRequest[];
}): ClassificationResult {
  const text = messageText(input.message);
  const { kind, rationale } = classifyKind(text);
  const referencedDecisionIds = findReferencedDecisions(
    new Set(tokenize(text)),
    input.priorChangeRequests,
  );
  return { suggestedKind: kind, rationale, referencedDecisionIds, summary: summarize(text) };
}
```

Modify `packages/orchestrator/src/index.ts` — add:

```ts
export * from './message-classifier.js';
```

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/orchestrator/src/message-classifier.test.ts
npm run typecheck
```

Expected: PASS, including the required "requirement change references an earlier confirmed
decision" test.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/message-classifier.ts packages/orchestrator/src/message-classifier.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): add deterministic message classifier"
```

---

### Task 4: `ContextCompiler` (bounded digest, compaction that never drops pinned/unresolved items)

**Files:**

- Create: `packages/orchestrator/src/context-compiler.ts`
- Create: `packages/orchestrator/src/context-compiler.test.ts`
- Modify: `packages/orchestrator/src/index.ts`

**Interfaces:**

- Consumes: `Message`, `ChangeRequest`, `ProjectVersion` (contracts).
- Produces:
  ```ts
  export interface CompiledContext {
    digest: string;
    sources: ContextSource[];
  }
  export function compileContext(input: {
    message: Message;
    changeRequest?: ChangeRequest | undefined;
    allChangeRequests: ChangeRequest[];
    versions: ProjectVersion[];
  }): CompiledContext;
  ```
  Task 6 (`conversation-operation-runner.ts`) imports `compileContext`/`CompiledContext` by these
  exact names, and appends `{ type: 'harness-fragment', id: <path> }` entries to `sources` itself
  after calling this function (harness fragments are not this module's concern — it has no
  `HarnessRepository` dependency).

- [ ] **Step 1: Write failing compiler tests**

Create `packages/orchestrator/src/context-compiler.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ChangeRequest, Message, ProjectVersion } from '@agent-foundry/contracts';
import { compileContext } from './context-compiler.js';

function message(id: string, text: string): Message {
  return {
    id,
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text }],
    sequence: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

function changeRequest(overrides: Partial<ChangeRequest> & { id: string }): ChangeRequest {
  return {
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: `${overrides.id}-message`,
    suggestedKind: 'build',
    summary: `summary for ${overrides.id}`,
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'confirmed',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function version(id: string, sequence: number): ProjectVersion {
  return {
    schemaVersion: '1',
    id,
    projectId: 'project-1',
    sequence,
    kind: 'run',
    runId: `run-${id}`,
    artifacts: [],
    protected: false,
    version: 1,
    createdAt: '2026-07-18T00:00:00.000Z',
  };
}

describe('compileContext', () => {
  it('never drops a referenced confirmed decision or a proposed decision from sources', () => {
    const referenced = changeRequest({ id: 'cr-referenced', status: 'confirmed' });
    const unresolved = changeRequest({ id: 'cr-unresolved', status: 'proposed' });
    const other = changeRequest({ id: 'cr-other', status: 'rejected' });
    const current = changeRequest({
      id: 'cr-current',
      status: 'proposed',
      referencedDecisionIds: ['cr-referenced'],
    });

    const compiled = compileContext({
      message: message('m1', 'Actually change the login flow.'),
      changeRequest: current,
      allChangeRequests: [referenced, unresolved, other, current],
      versions: [],
    });

    const sourceIds = compiled.sources.map((source) => source.id);
    expect(sourceIds).toContain('cr-referenced');
    expect(sourceIds).toContain('cr-unresolved');
    expect(sourceIds).toContain('cr-other');
    expect(compiled.digest).toContain('cr-referenced');
    expect(compiled.digest).toContain('cr-unresolved');
  });

  it('puts referenced and unresolved decisions in detailed sections, everything else compacted', () => {
    const referenced = changeRequest({ id: 'cr-referenced', status: 'confirmed', summary: 'Referenced decision text' });
    const unresolved = changeRequest({ id: 'cr-unresolved', status: 'proposed', summary: 'Unresolved feedback text' });
    const compacted = changeRequest({ id: 'cr-compacted', status: 'confirmed', summary: 'Old resolved decision text' });
    const current = changeRequest({
      id: 'cr-current',
      status: 'proposed',
      referencedDecisionIds: ['cr-referenced'],
    });

    const compiled = compileContext({
      message: message('m1', 'Actually change the login flow.'),
      changeRequest: current,
      allChangeRequests: [referenced, unresolved, compacted, current],
      versions: [],
    });

    expect(compiled.digest).toContain('## Pinned decisions');
    expect(compiled.digest).toContain('## Unresolved feedback');
    expect(compiled.digest).toContain('## Compacted history');
    expect(compiled.digest).toContain('Referenced decision text');
    expect(compiled.digest).toContain('Unresolved feedback text');
    expect(compiled.digest).toContain('cr-compacted');
  });

  it('lists recent project versions with a reference id', () => {
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: undefined,
      allChangeRequests: [],
      versions: [version('v-2', 2), version('v-1', 1)],
    });
    expect(compiled.digest).toContain('## Recent versions');
    expect(compiled.digest).toContain('v-2');
    expect(compiled.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['v-2', 'v-1']));
  });

  it('produces an empty digest with just the message source when there is no history', () => {
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: undefined,
      allChangeRequests: [],
      versions: [],
    });
    expect(compiled.digest).toBe('');
    expect(compiled.sources).toEqual([{ type: 'message', id: 'm1' }]);
  });

  it('never includes the current change request in its own digest', () => {
    const current = changeRequest({ id: 'cr-current', status: 'proposed' });
    const compiled = compileContext({
      message: message('m1', 'Add a login page.'),
      changeRequest: current,
      allChangeRequests: [current],
      versions: [],
    });
    expect(compiled.sources.map((s) => s.id)).not.toContain('cr-current');
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/orchestrator/src/context-compiler.test.ts
```

Expected: FAIL — `./context-compiler.js` doesn't exist.

- [ ] **Step 3: Implement the compiler**

Create `packages/orchestrator/src/context-compiler.ts`:

```ts
import type { ChangeRequest, ContextSource, Message, ProjectVersion } from '@agent-foundry/contracts';

export interface CompiledContext {
  digest: string;
  sources: ContextSource[];
}

/** ponytail: fixed recency window, revisit with a token budget once real conversations exist. */
const RECENT_CONFIRMED_WINDOW = 5;

export function compileContext(input: {
  message: Message;
  changeRequest?: ChangeRequest | undefined;
  allChangeRequests: ChangeRequest[];
  versions: ProjectVersion[];
}): CompiledContext {
  const currentId = input.changeRequest?.id;
  const others = input.allChangeRequests.filter((cr) => cr.id !== currentId);
  const referencedIds = new Set(input.changeRequest?.referencedDecisionIds ?? []);

  const confirmed = others
    .filter((cr) => cr.status === 'confirmed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const recentConfirmedIds = new Set(confirmed.slice(0, RECENT_CONFIRMED_WINDOW).map((cr) => cr.id));
  const pinned = confirmed.filter((cr) => referencedIds.has(cr.id) || recentConfirmedIds.has(cr.id));

  const unresolved = others.filter((cr) => cr.status === 'proposed');

  const detailedIds = new Set([...pinned, ...unresolved].map((cr) => cr.id));
  const compacted = others.filter((cr) => !detailedIds.has(cr.id));

  const sections: string[] = [];
  const sources: ContextSource[] = [{ type: 'message', id: input.message.id }];

  if (pinned.length) {
    sections.push(
      `## Pinned decisions\n\n${pinned
        .map((cr) => `- [${cr.id}] ${cr.summary} (kind: ${cr.confirmedKind ?? cr.suggestedKind})`)
        .join('\n')}`,
    );
    for (const cr of pinned) sources.push({ type: 'change-request', id: cr.id });
  }
  if (unresolved.length) {
    sections.push(
      `## Unresolved feedback\n\n${unresolved
        .map((cr) => `- [${cr.id}] ${cr.summary} (awaiting confirmation)`)
        .join('\n')}`,
    );
    for (const cr of unresolved) sources.push({ type: 'change-request', id: cr.id });
  }
  if (input.versions.length) {
    sections.push(
      `## Recent versions\n\n${input.versions
        .map((version) => `- [${version.id}] ${version.kind} at ${version.createdAt}`)
        .join('\n')}`,
    );
    for (const version of input.versions) sources.push({ type: 'project-version', id: version.id });
  }
  if (compacted.length) {
    sections.push(
      `## Compacted history\n\n${compacted.map((cr) => `- [${cr.id}] ${cr.summary}`).join('\n')}`,
    );
    for (const cr of compacted) sources.push({ type: 'change-request', id: cr.id });
  }

  return {
    digest: sections.length ? `${sections.join('\n\n')}\n` : '',
    sources,
  };
}
```

Modify `packages/orchestrator/src/index.ts` — add:

```ts
export * from './context-compiler.js';
```

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/orchestrator/src/context-compiler.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/context-compiler.ts packages/orchestrator/src/context-compiler.test.ts packages/orchestrator/src/index.ts
git commit -m "feat(orchestrator): add context compiler that never drops pinned or unresolved decisions"
```

---

### Task 5: `OperationService.classify()` / `.decideChangeRequest()`

**Files:**

- Modify: `packages/orchestrator/src/operation-service.ts`
- Modify: `packages/orchestrator/src/operation-service.test.ts`

**Interfaces:**

- Consumes: `classifyMessage` (Task 3), `ChangeRequestSchema`/`ChangeRequest` (Task 1),
  `ConversationService.createOperation` (existing).
- Produces:
  ```ts
  class OperationService {
    constructor(
      conversations: ConversationRepository,
      runs: WorkflowRunRepository,
      queue: JobQueue,
      artifacts: ArtifactStore,
      clock: Clock,
      ids: IdGenerator,
      conversationService: ConversationService, // NEW — 7th constructor arg
    );
    async classify(projectId: string, messageId: string): Promise<ChangeRequest>;
    async decideChangeRequest(
      projectId: string,
      changeRequestId: string,
      input: DecideChangeRequestRequest, // from Task 1
    ): Promise<{ changeRequest: ChangeRequest; operation?: Operation }>;
    async start(
      projectId: string,
      messageId: string,
      input: StartOperationRequest, // now may carry changeRequestId
    ): Promise<Operation>; // existing, gains changeRequestId passthrough only
  }
  ```
  Task 7 (`composition/runtime.ts`) passes `conversationService` as the new 7th constructor arg.
  Task 8 (`apps/api/src/app.ts`) calls `classify`/`decideChangeRequest` by these exact names.

- [ ] **Step 1: Write failing service tests**

This file (already read in full) has **no shared `setup()` helper today** — every one of its ~13
tests constructs `new MemoryConversations()`, `new MemoryRuns()`, `new MemoryQueue()`, and
`new OperationService(conversations, runs, queue, artifacts, new FixedClock(), new SequentialIds())`
inline, repeated near-identically. Since the constructor is gaining a required 7th argument
(`conversationService`), introduce a `setup()` helper now and point every existing call site at it —
this removes the duplication instead of repeating it a 14th time.

Add near the top of the file, after the existing `seedMessage`/`noArtifacts` functions:

```ts
import { InMemoryProjects } from './testing/harness.js';
import { ConversationService } from './conversation-service.js';

function setup(overrides: { artifacts?: ArtifactStore } = {}) {
  const conversations = new MemoryConversations();
  const runs = new MemoryRuns();
  const queue = new MemoryQueue();
  const artifacts = overrides.artifacts ?? noArtifacts();
  const projects = new InMemoryProjects({ on: true });
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const conversationService = new ConversationService(
    projects,
    runs,
    artifacts,
    conversations,
    clock,
    ids,
  );
  const service = new OperationService(
    conversations,
    runs,
    queue,
    artifacts,
    clock,
    ids,
    conversationService,
  );
  return { conversations, runs, queue, artifacts, projects, conversationService, service };
}
```

(Add the two new imports to the top of the file alongside the existing `OperationService` import.)

Then replace every existing inline construction with a `setup()` call. One worked example — the
first test in `describe('OperationService.start', ...)` (existing lines ~154-172):

```diff
   it('creates a queued plan operation, run, and job', async () => {
-    const conversations = new MemoryConversations();
-    const runs = new MemoryRuns();
-    const queue = new MemoryQueue();
+    const { service, conversations, runs, queue } = setup();
     const message = await seedMessage(conversations);
-    const service = new OperationService(
-      conversations,
-      runs,
-      queue,
-      noArtifacts(),
-      new FixedClock(),
-      new SequentialIds(),
-    );

     const operation = await service.start('project-1', message.id, { kind: 'plan' });
```

Apply the exact same substitution — delete the local `new MemoryConversations()` /
`new MemoryRuns()` / `new MemoryQueue()` / `new OperationService(...)` lines, replace with
`const { service, conversations, ... } = setup();` (destructure only what each test actually uses)
— at every remaining `new OperationService(` call site in this file: the rest of the
`OperationService.start` describe block (4 more sites), and in `OperationService.decide`'s describe
block, both the local `startAndCompletePlan(conversations, runs, queue, artifacts)` helper (change
its signature to `startAndCompletePlan(artifacts: ArtifactStore)`, call `setup({ artifacts })`
inside it instead of taking pre-built fakes as parameters, and update its 3 call sites to pass just
`artifacts`) and the 2 remaining direct `new OperationService(...)` sites in that block. Every
existing assertion in this file stays unchanged — only how `service`/`conversations`/`runs`/`queue`
get constructed changes.

Then add the new test cases:

```ts
describe('OperationService.classify', () => {
  it('creates a proposed change request from an unclassified message', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.status).toBe('proposed');
    expect(changeRequest.suggestedKind).toBe('build');
    expect(changeRequest.messageId).toBe(message.id);
  });

  it('is idempotent per message', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const first = await service.classify('project-1', message.id);
    const second = await service.classify('project-1', message.id);
    expect(second.id).toBe(first.id);
    expect(await conversations.listChangeRequests('project-1')).toHaveLength(1);
  });

  it('throws NotFoundError for a missing message', async () => {
    const { service } = setup();
    await expect(service.classify('project-1', 'missing')).rejects.toThrow('Message missing not found');
  });
});

describe('OperationService.decideChangeRequest', () => {
  it('confirming a plan classification starts an Operation with changeRequestId set', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Let us think about onboarding.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('plan');

    const { changeRequest: decided, operation } = await service.decideChangeRequest(
      'project-1',
      changeRequest.id,
      { action: 'confirm', kind: 'plan' },
    );
    expect(decided.status).toBe('confirmed');
    expect(decided.confirmedKind).toBe('plan');
    expect(operation?.changeRequestId).toBe(changeRequest.id);
    expect(decided.operationId).toBe(operation?.id);
  });

  it('lets the user correct build to plan before anything executes', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('build');

    const { operation } = await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'plan',
    });
    expect(operation?.kind).toBe('plan');
  });

  it('still requires exactly one of planOperationId/directExecution when confirming build', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    await expect(
      service.decideChangeRequest('project-1', changeRequest.id, { action: 'confirm', kind: 'build' }),
    ).rejects.toThrow();
  });

  it('rejecting leaves no operation and marks the change request rejected', async () => {
    const { service, conversations } = setup();
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    const { changeRequest: decided, operation } = await service.decideChangeRequest(
      'project-1',
      changeRequest.id,
      { action: 'reject' },
    );
    expect(decided.status).toBe('rejected');
    expect(operation).toBeUndefined();
    expect(await conversations.listOperations('project-1')).toHaveLength(0);
  });

  it('confirming explain routes through the legacy audit-only createOperation path', async () => {
    const { service, conversations, projects } = setup();
    await projects.create({
      id: 'project-1',
      name: 'Test project',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'queued',
      version: 1,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    });
    const message = await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Why does the login page redirect to the dashboard?' }],
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    const changeRequest = await service.classify('project-1', message.id);
    expect(changeRequest.suggestedKind).toBe('explain');
    const { operation } = await service.decideChangeRequest('project-1', changeRequest.id, {
      action: 'confirm',
      kind: 'explain',
    });
    expect(operation?.kind).toBe('explain');
    expect(operation?.runId).toBeUndefined();
  });
});
```

Every other new test above (`classify` idempotency/missing-message, `decideChangeRequest` plan/build
confirm, build-gating, reject) uses kinds that never reach `conversationService.createOperation()`
(they resolve through `this.start()` instead, which — like today — never checks for a `Project`
record), so they don't need `projects.create(...)` seeding; only this one explain test does.

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/orchestrator/src/operation-service.test.ts
```

Expected: FAIL — `classify`/`decideChangeRequest` don't exist; constructor arity mismatch once the
test setup passes a 7th argument.

- [ ] **Step 3: Implement `classify()` and `decideChangeRequest()`**

Modify `packages/orchestrator/src/operation-service.ts`:

```ts
import type {
  ChangeRequest,
  DecideChangeRequestRequest,
  Operation,
  StartOperationRequest,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { ChangeRequestSchema } from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type IdGenerator,
  type JobQueue,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { CONVERSATION_WORKFLOW_ID } from './conversation-step-config.js';
import { classifyMessage } from './message-classifier.js';
import type { ConversationService } from './conversation-service.js';
import { sha256 } from './idempotency.js';

export class OperationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly queue: JobQueue,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly conversationService: ConversationService,
  ) {}

  async classify(projectId: string, messageId: string): Promise<ChangeRequest> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);

    const priorChangeRequests = await this.conversations.listChangeRequests(projectId);
    const existing = priorChangeRequests.find((cr) => cr.messageId === messageId);
    if (existing) return existing;

    const result = classifyMessage({ message, priorChangeRequests });
    return this.conversations.createChangeRequest(
      ChangeRequestSchema.parse({
        id: this.ids.next(),
        projectId,
        conversationId: projectId,
        messageId,
        suggestedKind: result.suggestedKind,
        summary: result.summary,
        rationale: result.rationale,
        referencedDecisionIds: result.referencedDecisionIds,
        contextSources: [],
        status: 'proposed',
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async decideChangeRequest(
    projectId: string,
    changeRequestId: string,
    input: DecideChangeRequestRequest,
  ): Promise<{ changeRequest: ChangeRequest; operation?: Operation }> {
    const changeRequest = await this.conversations.getChangeRequest(projectId, changeRequestId);
    if (!changeRequest) throw new NotFoundError(`Change request ${changeRequestId} not found`);
    if (changeRequest.status !== 'proposed') {
      throw new ValidationError(`Change request ${changeRequestId} has already been decided`);
    }

    if (input.action === 'reject') {
      const rejected = await this.conversations.updateChangeRequest({
        ...changeRequest,
        status: 'rejected',
        decidedAt: this.clock.now().toISOString(),
      });
      return { changeRequest: rejected };
    }

    const operation =
      input.kind === 'plan' || input.kind === 'build'
        ? await this.start(projectId, changeRequest.messageId, {
            kind: input.kind,
            planOperationId: input.planOperationId,
            directExecution: input.directExecution,
            changeRequestId: changeRequest.id,
          })
        : await this.conversationService.createOperation(projectId, changeRequest.messageId, {
            kind: input.kind,
            // IdempotencyKeySchema requires 64 lowercase hex chars — changeRequest.id itself
            // (a PathSegmentSchema id) does not match, so hash it the same way start() hashes
            // operationId/runId into idempotencyKey() below.
            idempotencyKey: sha256(changeRequest.id),
            changeRequestId: changeRequest.id,
            artifactReferences: [],
          });

    const confirmed = await this.conversations.updateChangeRequest({
      ...changeRequest,
      status: 'confirmed',
      confirmedKind: input.kind,
      operationId: operation.id,
      decidedAt: this.clock.now().toISOString(),
    });
    return { changeRequest: confirmed, operation };
  }

  async start(
    projectId: string,
    messageId: string,
    input: StartOperationRequest,
  ): Promise<Operation> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);
    if (input.kind === 'build' && !input.planOperationId && !input.directExecution) {
      throw new ValidationError('Build requires an approved planOperationId or directExecution');
    }

    let artifactReferences: Operation['artifactReferences'] = [];
    if (input.kind === 'build' && input.planOperationId) {
      const plan = await this.conversations.getOperation(projectId, input.planOperationId);
      if (!plan || plan.kind !== 'plan') {
        throw new ValidationError(`Plan operation ${input.planOperationId} not found`);
      }
      if (plan.approval?.status !== 'approved') {
        throw new ValidationError(`Plan operation ${input.planOperationId} is not approved`);
      }
      artifactReferences = plan.artifactReferences;
    }

    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const operationId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: CONVERSATION_WORKFLOW_ID[input.kind],
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);

    const operation = await this.conversations.createOperation({
      id: operationId,
      projectId,
      conversationId: projectId,
      messageId,
      kind: input.kind,
      idempotencyKey: this.idempotencyKey(operationId, runId),
      runId,
      artifactReferences,
      ...(input.changeRequestId ? { changeRequestId: input.changeRequestId } : {}),
      ...(input.kind === 'plan' ? { approval: { status: 'pending' as const } } : {}),
      ...(input.kind === 'build' && input.planOperationId
        ? { planOperationId: input.planOperationId }
        : {}),
      ...(input.kind === 'build' && input.directExecution ? { directExecution: true } : {}),
      createdAt: now,
    });

    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-conversation-operation',
      projectId,
      workflowId: run.workflowId,
      runId,
      operationId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });

    return operation;
  }

  async decide(
    projectId: string,
    operationId: string,
    action: 'approve' | 'reject',
  ): Promise<Operation> {
    const operation = await this.conversations.getOperation(projectId, operationId);
    if (!operation) throw new NotFoundError(`Operation ${operationId} not found`);
    if (operation.kind !== 'plan') {
      throw new ValidationError(`Operation ${operationId} is not a plan operation`);
    }
    if (!operation.runId) throw new ValidationError(`Operation ${operationId} has no run`);
    const run = await this.runs.get(operation.runId);
    if (!run || run.status !== 'completed') {
      throw new ValidationError(`Operation ${operationId}'s run has not completed`);
    }

    if (action === 'reject') {
      return this.conversations.updateOperation({
        ...operation,
        approval: { status: 'rejected', decidedAt: this.clock.now().toISOString() },
      });
    }

    const artifact = await this.artifacts.getLatest(projectId, `operation-${operationId}`);
    if (!artifact) throw new NotFoundError(`Plan artifact for operation ${operationId} not found`);
    return this.conversations.updateOperation({
      ...operation,
      approval: { status: 'approved', decidedAt: this.clock.now().toISOString() },
      artifactReferences: [
        {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
      ],
    });
  }

  protected idempotencyKey(operationId: string, runId: string): string {
    return sha256(`${operationId}:${runId}`);
  }
}
```

Note `start()`'s only changes from the existing file are: the `input.changeRequestId` spread into the
created `Operation`, and the new parameter type already carrying it (Task 1). Everything else in
`start()`/`decide()`/`idempotencyKey()` is copied unchanged — do not alter their existing behavior.

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/orchestrator/src/operation-service.test.ts
npm run typecheck
```

Expected: PASS, including every pre-existing test in this file with the new 7th constructor
argument wired through `setup()`.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/operation-service.ts packages/orchestrator/src/operation-service.test.ts
git commit -m "feat(orchestrator): add OperationService.classify and decideChangeRequest"
```

---

### Task 6: Wire context compilation and provenance into `ConversationOperationRunner`

**Files:**

- Modify: `packages/orchestrator/src/conversation-step-config.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.ts`
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`

**Interfaces:**

- Consumes: `compileContext`/`CompiledContext` (Task 4), `ProjectVersionRepository` (existing domain
  port).
- Produces: `buildConversationStep` gains an optional `contextDigest?: string` input param (appended
  as a `## Context` section in `instructions`); `ConversationOperationRunner` constructor gains a new
  12th positional arg `projectVersions: ProjectVersionRepository`, inserted **immediately after**
  `conversations` (existing arg 11) and **before** `clock` (existing arg 12) — Task 7 must pass it in
  that exact position. `FakeWorkspaces.writeRunContext` gains a captured `lastRequestMarkdown` field
  for test assertions.

- [ ] **Step 1: Write failing runner tests**

`packages/orchestrator/src/testing/harness.ts`'s `FakeWorkspaces.writeRunContext` currently ignores
its input and returns fixed paths — it never records what was written, so there is no way to assert
the compiled digest reached the prompt. Modify it first (find the existing method, ~line 555):

```ts
  lastRequestMarkdown: string | undefined;
  writeRunContext(input: {
    requestMarkdown: string;
  }): Promise<{ requestPath: string; schemaPath: string }> {
    checkPower(this.power);
    this.lastRequestMarkdown = input.requestMarkdown;
    return Promise.resolve({ requestPath: 'request.md', schemaPath: 'schema.json' });
  }
```

(Add `lastRequestMarkdown` as a public field declaration alongside the class's other public fields
like `checkpoints`/`commits`; keep the existing `writeRunContext` method's position in the class,
just widen its signature to accept and capture `input.requestMarkdown` instead of ignoring its
argument entirely.)

In `packages/orchestrator/src/conversation-operation-runner.test.ts`, add a minimal in-memory
`ProjectVersionRepository` fake near the file's existing `MemoryConversations` class, and extend
`setup()` to accept it and an optional custom `HarnessRepository`:

```ts
class MemoryProjectVersions implements ProjectVersionRepository {
  private readonly store: ProjectVersion[] = [];
  create(version: ProjectVersion): Promise<void> {
    this.store.push(version);
    return Promise.resolve();
  }
  get(projectId: string, versionId: string): Promise<ProjectVersion | null> {
    return Promise.resolve(
      this.store.find((v) => v.projectId === projectId && v.id === versionId) ?? null,
    );
  }
  list(projectId: string, limit = 50): Promise<ProjectVersion[]> {
    return Promise.resolve(
      this.store
        .filter((v) => v.projectId === projectId)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, limit),
    );
  }
  update(version: ProjectVersion, _expectedVersion: number): Promise<ProjectVersion> {
    const index = this.store.findIndex((v) => v.id === version.id);
    this.store[index] = version;
    return Promise.resolve(version);
  }
}
```

Replace the file's existing `function setup() { ... }` with a version that takes an optional harness
override and also builds/returns `projectVersions`:

```ts
function setup(harness: HarnessRepository = harnessRepo) {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const projectVersions = new MemoryProjectVersions();
  const executor = new ControllableAgentExecutor({}, workspaces);
  const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    harness,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    projectVersions,
    new FixedClock(),
    new SequentialIds(),
    { agentTimeoutMs: 60_000 },
  );
  return {
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    workspaces,
    conversations,
    projectVersions,
    runner,
  };
}
```

Every existing call to `setup()` in this file (no arguments) keeps working unchanged — `harness`
defaults to the file's existing module-level `harnessRepo` constant. Add `ProjectVersion, type
ProjectVersionRepository` to this file's existing imports (contracts and domain respectively). Then
add the new test cases:

```ts
describe('ConversationOperationRunner context compilation', () => {
  it('embeds the compiled context digest in the compiled instructions and records sources on the change request', async () => {
    const fragmentHarness: HarnessRepository = {
      select: () =>
        Promise.resolve({
          version: 'v1',
          files: [{ path: 'CLAUDE.md', content: 'Be terse.', priority: 1 }],
          combined: 'Be terse.',
        }),
      version: () => Promise.resolve('v1'),
    };
    const { runs, workspaces, conversations, runner } = setup(fragmentHarness);
    await conversations.createConversation({
      id: 'project-1',
      projectId: 'project-1',
      createdAt: '2026-07-18T11:00:00.000Z',
    });
    await conversations.appendMessage({
      id: 'message-earlier',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
      createdAt: '2026-07-18T11:00:00.000Z',
    });
    const confirmedDecision = await conversations.createChangeRequest({
      id: 'cr-earlier',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-earlier',
      suggestedKind: 'build',
      confirmedKind: 'build',
      summary: 'Add a login page with email and password.',
      rationale: 'Imperative verb.',
      referencedDecisionIds: [],
      contextSources: [],
      status: 'confirmed',
      createdAt: '2026-07-18T11:00:00.000Z',
      decidedAt: '2026-07-18T11:00:01.000Z',
    });
    await conversations.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Change the login page to use magic links.' }],
      createdAt: '2026-07-18T12:00:00.000Z',
    });
    const changeRequest = await conversations.createChangeRequest({
      id: 'cr-current',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      suggestedKind: 'build',
      summary: 'Change the login page to use magic links.',
      rationale: 'Imperative verb.',
      referencedDecisionIds: [confirmedDecision.id],
      contextSources: [],
      status: 'proposed',
      createdAt: '2026-07-18T12:00:00.000Z',
    });
    const runId = 'run-1';
    const operationId = 'operation-1';
    await runs.create({
      id: runId,
      projectId: 'project-1',
      workflowId: 'conversation-build',
      status: 'queued',
      version: 1,
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
    });
    await conversations.createOperation({
      id: operationId,
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'build',
      idempotencyKey: 'a'.repeat(64),
      runId,
      changeRequestId: changeRequest.id,
      directExecution: true,
      artifactReferences: [],
      createdAt: '2026-07-18T12:00:00.000Z',
    });

    await runner.run('project-1', runId, operationId);

    expect(workspaces.lastRequestMarkdown).toContain('Pinned decisions');
    expect(workspaces.lastRequestMarkdown).toContain(confirmedDecision.id);

    const updatedChangeRequest = await conversations.getChangeRequest('project-1', changeRequest.id);
    const sourceIds = updatedChangeRequest?.contextSources.map((s) => s.id) ?? [];
    expect(sourceIds).toContain(confirmedDecision.id);
    expect(sourceIds).toContain('CLAUDE.md');
  });

  it('runs unaffected when the operation has no changeRequestId (existing manual-toggle path)', async () => {
    const { runs, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/orchestrator/src/conversation-operation-runner.test.ts
```

Expected: FAIL — constructor arity mismatch (`projectVersions` not yet accepted), no context digest
embedded, `contextSources` never persisted.

- [ ] **Step 3: Wire the compiler into the runner**

Modify `packages/orchestrator/src/conversation-step-config.ts` — extend `buildConversationStep`:

```ts
export function buildConversationStep(input: {
  operationId: string;
  kind: 'plan' | 'build';
  message: Message;
  planArtifact?: { content: unknown } | undefined;
  contextDigest?: string | undefined;
}): AgentStep {
  const base = STEP_BASE[input.kind];
  const planSection = input.planArtifact
    ? `\n\n## Approved plan\n\n\`\`\`json\n${JSON.stringify(input.planArtifact.content, null, 2)}\n\`\`\`\n`
    : '';
  const contextSection = input.contextDigest ? `\n\n${input.contextDigest}` : '';
  return {
    ...base,
    id: `conversation-${input.kind}-${input.operationId}`,
    instructions: `${messageText(input.message)}${contextSection}${planSection}`,
  };
}
```

Modify `packages/orchestrator/src/conversation-operation-runner.ts`:

1. Add imports:

```ts
import type { ProjectVersionRepository } from '@agent-foundry/domain';
import { compileContext } from './context-compiler.js';
```

2. Add the constructor parameter, immediately after `conversations` and before `clock`:

```ts
export class ConversationOperationRunner {
  constructor(
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly metrics: MetricsRepository,
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: WorkspaceManager,
    private readonly conversations: ConversationRepository,
    private readonly projectVersions: ProjectVersionRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ConversationOperationRunnerOptions,
  ) {}
```

3. In `run()`, replace the step-building line and insert context compilation before it:

```ts
    const initialRun = await this.requireRun(runId);
    const operation = await this.requireOperation(projectId, operationId);
    const kind: 'plan' | 'build' = operation.kind === 'build' ? 'build' : 'plan';
    const message = await this.requireMessage(projectId, operation.messageId);
    const planArtifact = await this.loadPlanArtifact(projectId, operation);
    const changeRequest = operation.changeRequestId
      ? await this.conversations.getChangeRequest(projectId, operation.changeRequestId)
      : undefined;
    const allChangeRequests = await this.conversations.listChangeRequests(projectId);
    const versions = await this.projectVersions.list(projectId, 5);
    const compiledContext = compileContext({
      message,
      changeRequest,
      allChangeRequests,
      versions,
    });
    const step = buildConversationStep({
      operationId,
      kind,
      message,
      planArtifact,
      contextDigest: compiledContext.digest,
    });
```

4. Right after the existing `const harness = await this.harness.select({...});` call inside the
   `try` block, add provenance persistence:

```ts
      const harness = await this.harness.select({
        role: step.role,
        taskKind: step.taskKind,
        stack: 'conversation',
        tags: step.harnessTags,
      });
      if (changeRequest) {
        await this.conversations.updateChangeRequest({
          ...changeRequest,
          contextSources: [
            ...compiledContext.sources,
            ...harness.files.map((file) => ({ type: 'harness-fragment' as const, id: file.path })),
          ],
        });
      }
```

Everything else in `run()` (the rest of the `try` block, the `catch` block, the private helpers)
stays exactly as it is today — this task only touches the two spots above.

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/orchestrator/src/conversation-operation-runner.test.ts packages/orchestrator/src/plan-build-modes.test.ts
npm run typecheck
```

Expected: PASS, including every pre-existing test with the new constructor argument wired through.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/conversation-step-config.ts packages/orchestrator/src/conversation-operation-runner.ts packages/orchestrator/src/conversation-operation-runner.test.ts
git commit -m "feat(orchestrator): embed compiled context digest and record prompt provenance"
```

---

### Task 7: Composition wiring

**Files:**

- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Consumes: `OperationService`'s new 7th constructor arg (Task 5), `ConversationOperationRunner`'s
  new `projectVersions` arg (Task 6) — both already-built values in this file
  (`conversationService`, `projectVersions`), no new construction needed.

- [ ] **Step 1: Update the two constructor call sites**

Modify `packages/composition/src/runtime.ts` — `operationRunner` gains `projectVersions` in the exact
position Task 6 specified (after `conversations`, before `clock`):

```ts
  const operationRunner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    harness,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    projectVersions,
    clock,
    ids,
    { agentTimeoutMs: config.agentTimeoutMs },
  );
```

`operationService` gains `conversationService` as its 7th argument — note `conversationService` must
already be constructed above this line (it is, per the file's existing order: `conversationService`
is built before `operationRunner`/`operationService`):

```ts
  const operationService = new OperationService(
    conversations,
    runs,
    queue,
    artifacts,
    clock,
    ids,
    conversationService,
  );
```

- [ ] **Step 2: Verify GREEN**

```bash
npm run typecheck
npm run build:packages
```

Expected: PASS — this file has no dedicated unit test (composition wiring is covered end-to-end by
`apps/api`'s integration tests, exercised in Task 8).

- [ ] **Step 3: Commit**

```bash
git add packages/composition/src/runtime.ts
git commit -m "feat(composition): wire ChangeRequest classification into the runtime"
```

---

### Task 8: API routes and integration test (roadmap's required scenario)

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/conversation.test.ts`

**Interfaces:**

- Consumes: `OperationService.classify/decideChangeRequest` (Task 5),
  `ClassifyMessageResponseSchema`/`DecideChangeRequestRequestSchema`/`DecideChangeRequestResponseSchema`
  (Task 1).
- Produces:
  - `POST /projects/:projectId/conversation/messages/:messageId/classify` → 201
    `{ changeRequest }`.
  - `POST /projects/:projectId/conversation/change-requests/:changeRequestId/decide` → 200
    `{ changeRequest, operation? }`.

- [ ] **Step 1: Write failing API tests**

Add to `apps/api/src/conversation.test.ts` (reuse this file's existing `startApi()`/`createProject()`/
`post()` helpers exactly as shown earlier in this plan's research — read the top of the file first,
it's already summarized above):

```ts
describe('classify and decide change request', () => {
  it('classifies a message, lets the user confirm it as-is, and starts a plan operation', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const messageResponse = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'text', text: 'Let us think about the onboarding flow.' }],
    });
    const { message } = (await messageResponse.json()) as { message: Message };

    const classifyResponse = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${message.id}/classify`,
      {},
    );
    expect(classifyResponse.status).toBe(201);
    const { changeRequest } = (await classifyResponse.json()) as { changeRequest: { id: string; suggestedKind: string } };
    expect(changeRequest.suggestedKind).toBe('plan');

    const decideResponse = await post(
      baseUrl,
      `/projects/${projectId}/conversation/change-requests/${changeRequest.id}/decide`,
      { action: 'confirm', kind: 'plan' },
    );
    expect(decideResponse.status).toBe(200);
    const decided = (await decideResponse.json()) as { changeRequest: { status: string }; operation: { kind: string } };
    expect(decided.changeRequest.status).toBe('confirmed');
    expect(decided.operation.kind).toBe('plan');
  });

  it('lets the user correct a build suggestion to plan before anything executes', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const messageResponse = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password.' }],
    });
    const { message } = (await messageResponse.json()) as { message: Message };
    const classifyResponse = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${message.id}/classify`,
      {},
    );
    const { changeRequest } = (await classifyResponse.json()) as { changeRequest: { id: string; suggestedKind: string } };
    expect(changeRequest.suggestedKind).toBe('build');

    const decideResponse = await post(
      baseUrl,
      `/projects/${projectId}/conversation/change-requests/${changeRequest.id}/decide`,
      { action: 'confirm', kind: 'plan' },
    );
    const decided = (await decideResponse.json()) as { operation: { kind: string } };
    expect(decided.operation.kind).toBe('plan');
  });

  it('roadmap scenario: a later requirement change classifies and references an earlier confirmed decision', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);

    const firstMessage = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page with email and password fields.' }],
    });
    const { message: firstMsg } = (await firstMessage.json()) as { message: Message };
    const firstClassify = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${firstMsg.id}/classify`,
      {},
    );
    const { changeRequest: firstCr } = (await firstClassify.json()) as { changeRequest: { id: string } };
    await post(
      baseUrl,
      `/projects/${projectId}/conversation/change-requests/${firstCr.id}/decide`,
      { action: 'confirm', kind: 'build', directExecution: true },
    );

    const secondMessage = await post(baseUrl, `/projects/${projectId}/conversation/messages`, {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Actually change the login page to use magic links instead of a password field.',
        },
      ],
    });
    const { message: secondMsg } = (await secondMessage.json()) as { message: Message };
    const secondClassify = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${secondMsg.id}/classify`,
      {},
    );
    expect(secondClassify.status).toBe(201);
    const { changeRequest: secondCr } = (await secondClassify.json()) as {
      changeRequest: { suggestedKind: string; referencedDecisionIds: string[] };
    };
    expect(secondCr.suggestedKind).toBe('build');
    expect(secondCr.referencedDecisionIds).toContain(firstCr.id);
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- apps/api/src/conversation.test.ts
```

Expected: FAIL — 404 on the two new routes (they don't exist yet).

- [ ] **Step 3: Add the routes**

Modify `apps/api/src/app.ts` — add the import for the new schemas near the existing conversation/api
imports:

```ts
import {
  ClassifyMessageResponseSchema,
  DecideChangeRequestRequestSchema,
  DecideChangeRequestResponseSchema,
} from '@agent-foundry/contracts';
```

Add the two routes immediately after the existing
`/projects/:projectId/conversation/operations/:operationId/decide` route:

```ts
  app.post(
    '/projects/:projectId/conversation/messages/:messageId/classify',
    async (request, reply) => {
      const { projectId, messageId } = z
        .object({ projectId: PathSegmentSchema, messageId: PathSegmentSchema })
        .parse(request.params);
      const changeRequest = await runtime.operationService.classify(projectId, messageId);
      return reply.status(201).send(ClassifyMessageResponseSchema.parse({ changeRequest }));
    },
  );

  app.post(
    '/projects/:projectId/conversation/change-requests/:changeRequestId/decide',
    async (request, reply) => {
      const { projectId, changeRequestId } = z
        .object({ projectId: PathSegmentSchema, changeRequestId: PathSegmentSchema })
        .parse(request.params);
      const input = DecideChangeRequestRequestSchema.parse(request.body);
      const result = await runtime.operationService.decideChangeRequest(
        projectId,
        changeRequestId,
        input,
      );
      return reply.status(200).send(DecideChangeRequestResponseSchema.parse(result));
    },
  );
```

Match this file's exact existing style for parsing params (`PathSegmentSchema`, `z.object(...).parse`)
— it's already imported/used by the neighboring routes, don't re-import `z`/`PathSegmentSchema` if
already present in this file's import block.

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- apps/api/src/conversation.test.ts
npm run typecheck
```

Expected: PASS, including the roadmap-required scenario test.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/conversation.test.ts
git commit -m "feat(api): add classify and decide-change-request routes"
```

---

### Task 9: Web UI — classify-then-confirm flow

**Files:**

- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**

- Consumes: the two new routes (Task 8).
- Produces: `classifyMessage(projectId, messageId)` and
  `decideChangeRequest(projectId, changeRequestId, input)` wrapper functions in `lib/api.ts`,
  mirroring the file's existing `startOperation`/`decideOperation` wrapper shape exactly (same
  fetch/error-handling pattern — read those two functions first and copy their structure).

- [ ] **Step 1: Add API client wrappers**

Modify `apps/web/lib/api.ts` — add immediately after the existing `decideOperation` function, in the
same style (same base-URL handling, same JSON parse/error-throw pattern as `startOperation` two
functions above it):

```ts
export async function classifyMessage(
  projectId: string,
  messageId: string,
): Promise<ClassifyMessageResponse> {
  const response = await fetch(
    `${API_BASE}/projects/${projectId}/conversation/messages/${messageId}/classify`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<ClassifyMessageResponse>;
}

export async function decideChangeRequest(
  projectId: string,
  changeRequestId: string,
  input: DecideChangeRequestRequest,
): Promise<DecideChangeRequestResponse> {
  const response = await fetch(
    `${API_BASE}/projects/${projectId}/conversation/change-requests/${changeRequestId}/decide`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<DecideChangeRequestResponse>;
}
```

Add `ClassifyMessageResponse, DecideChangeRequestRequest, DecideChangeRequestResponse` to this file's
existing `@agent-foundry/contracts` type import list. Match `API_BASE`/error-handling exactly as the
neighboring `startOperation`/`decideOperation` functions already do — read them first rather than
guessing the base URL constant's name.

- [ ] **Step 2: Wire the composer through classify → confirm**

Modify `apps/web/app/project/[id]/page.tsx`. The existing file already computes, just above
`submitMessage()`:

```ts
  const latestApprovedPlan = conversation?.operations
    .filter((op) => op.kind === 'plan' && op.approval?.status === 'approved')
    .at(-1);
```

Reuse this exact variable (do not duplicate the lookup).

1. Add state near the existing `mode`/`buildChoice`/`conversationError` declarations:

```ts
  const [pendingChangeRequest, setPendingChangeRequest] = useState<ChangeRequest | null>(null);
```

Add `ChangeRequest, OperationKind` to this file's existing `@agent-foundry/contracts` type import
list.

2. Replace the existing `submitMessage()` function's body (currently sends the message, then
   immediately branches on `mode`/`buildChoice` to call `startOperation`) with a version that
   classifies instead of starting an operation directly:

```ts
  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      const message = await sendMessage(id, {
        role: 'user',
        content: [{ type: 'text', text: draft }],
      });
      setDraft('');
      setConversationError('');
      const { changeRequest } = await classifyMessage(id, message.id);
      setPendingChangeRequest(changeRequest);
      if (changeRequest.suggestedKind === 'plan' || changeRequest.suggestedKind === 'build') {
        setMode(changeRequest.suggestedKind);
      }
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function confirmChangeRequest() {
    if (!pendingChangeRequest) return;
    const kind: OperationKind =
      pendingChangeRequest.suggestedKind === 'plan' || pendingChangeRequest.suggestedKind === 'build'
        ? mode
        : pendingChangeRequest.suggestedKind;
    try {
      await decideChangeRequest(id, pendingChangeRequest.id, {
        action: 'confirm',
        kind,
        ...(kind === 'build'
          ? buildChoice === 'plan' && latestApprovedPlan
            ? { planOperationId: latestApprovedPlan.id }
            : { directExecution: true }
          : {}),
      });
      setPendingChangeRequest(null);
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function discardChangeRequest() {
    if (!pendingChangeRequest) return;
    await decideChangeRequest(id, pendingChangeRequest.id, { action: 'reject' });
    setPendingChangeRequest(null);
  }
```

This mirrors the existing function's `try`/`catch`/`setConversationError` structure exactly — only
the body changed from "classify then immediately start" to "classify, wait for the confirm click".

3. Add a small inline confirmation card, rendered when `pendingChangeRequest` is set, placed directly
   above the existing Plan/Build radio toggle. For `plan`/`build` suggestions, the existing radio
   toggle (`mode` state) *is* the correction control — the card just labels it; `explain`/`repair`/
   `visual-edit` suggestions (no existing radio for these) get a direct confirm with no override,
   matching how those three kinds have no dedicated UI today either:

```tsx
{pendingChangeRequest && (
  <div className="panel" style={{ marginBottom: '0.5rem' }}>
    <p>
      Suggested: <strong>{pendingChangeRequest.suggestedKind}</strong> — {pendingChangeRequest.rationale}
    </p>
    {pendingChangeRequest.referencedDecisionIds.length > 0 && (
      <p>References: {pendingChangeRequest.referencedDecisionIds.join(', ')}</p>
    )}
    {(pendingChangeRequest.suggestedKind === 'plan' || pendingChangeRequest.suggestedKind === 'build') && (
      <p>Use the Plan/Build toggle below to confirm or correct this before sending.</p>
    )}
    <button onClick={confirmChangeRequest}>
      Confirm{' '}
      {pendingChangeRequest.suggestedKind === 'plan' || pendingChangeRequest.suggestedKind === 'build'
        ? mode
        : pendingChangeRequest.suggestedKind}
    </button>
    <button onClick={discardChangeRequest}>Discard</button>
  </div>
)}
```

- [ ] **Step 3: Manually verify in the dev server**

```bash
npm run dev:inline
```

In a browser: open a project, send a message like "Add a login page with email and password" —
confirm the suggestion card shows `build` with a rationale, change the toggle to `plan`, click
Confirm, and confirm a Plan Operation appears (not a Build). Send a follow-up message referencing the
same feature in different words and confirm the suggestion card's "References" line appears once
that first change request is confirmed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api.ts "apps/web/app/project/[id]/page.tsx"
git commit -m "feat(web): show classifier suggestion and let the user correct it before Build"
```

---

### Task 10: Docs, follow-up issue, and full verification

**Files:**

- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Document the classification/context-compilation flow**

Modify `docs/ARCHITECTURE.md` — add a new section immediately after the existing "### Gating do
Build" subsection (end of the "## Execução de operações (Plan/Build)" section) and before "##
Conversa persistida por projeto", in Portuguese to match the surrounding document:

```markdown
### Classificação de mensagem e compilação de contexto

`OperationService.classify()` (packages/orchestrator) roda uma classificação determinística e pura
sobre o texto da mensagem (`message-classifier.ts` — sem chamada a modelo, sem I/O) e persiste um
`ChangeRequest` com `status: 'proposed'`, o `OperationKind` sugerido, uma justificativa, e
`referencedDecisionIds` — outros `ChangeRequest`s `confirmed` cujo resumo compartilha duas ou mais
palavras significativas com a mensagem atual. `classify()` é idempotente por mensagem.

`OperationService.decideChangeRequest()` é o único caminho que transforma uma classificação em
`Operation`: `'reject'` marca o change request como `rejected` sem criar nada; `'confirm'` aceita um
`kind` que pode divergir da sugestão — essa divergência é a correção do usuário — e só então cria a
`Operation`, via `start()` para `plan`/`build` ou via `ConversationService.createOperation()` para os
demais kinds. `Build` nunca é criado automaticamente a partir de `classify()`.

`ConversationOperationRunner` compila um digest limitado (`context-compiler.ts`, também
determinístico) a partir do `ChangeRequest` da operação: decisões `confirmed` referenciadas ou
recentes ficam detalhadas ("Pinned decisions"), `ChangeRequest`s `proposed` ficam sempre detalhados
("Unresolved feedback"), `ProjectVersion`s recentes aparecem com seu id, e todo o resto vira uma
linha compacta com id + resumo — nunca desaparece da lista de `sources`, só perde detalhe. Após
`harness.select()`, os caminhos dos fragmentos de harness selecionados (as "knowledge files" do
prompt — não existe ainda um repositório de arquivos de conhecimento enviados pelo usuário; ver
`v06-knowledge-attachments-shell`) são adicionados a `sources` e persistidos de volta no
`ChangeRequest`, independente do sucesso da execução do agente.
```

- [ ] **Step 2: Create the follow-up issue for LLM-driven classification**

```bash
gh issue create --repo eedsilva/agent-foundry \
  --title "Upgrade message classifier with LLM-driven (or hybrid) intent detection" \
  --body "Follow-up to #38. The message classifier shipped in #38 is intentionally pure/deterministic (regex rules over message text) for reproducibility, zero added latency/cost, and testability — see the 'Classifier: deterministic, not LLM-driven' section of docs/superpowers/specs/2026-07-18-issue-38-chat-operations-design.md. It will misclassify genuinely ambiguous phrasing that no keyword rule set can cover; the mitigation today is the user-correction step (OperationService.decideChangeRequest), not classifier sophistication. Once real conversation volume shows the rule set's actual failure modes, revisit with either a full LLM classification step or a rules-first/LLM-fallback hybrid (both considered and deferred at #38 time)." \
  --label "kind:feature"
```

Confirm the issue number returned, and note it in the PR description for #38 (Step 5 below).

- [ ] **Step 3: Full verification**

```bash
npm run check
```

Expected: PASS — format, lint, architecture, roadmap, typecheck, unit tests, and build all green.

- [ ] **Step 4: Manual golden-path check**

Repeat Task 9 Step 3's manual dev-server check once more end-to-end after all tasks land, this time
also exercising: a `repair` message ("fix the broken login button"), an `explain` message ("why does
the dashboard redirect?"), and confirming each routes to the correct kind and (for repair/explain)
does not require the plan/direct-execution choice at all.

- [ ] **Step 5: Commit and open the PR**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): document classification and context compilation"
git push -u origin worktree-issue-38-change-requests
gh pr create --repo eedsilva/agent-foundry \
  --title "[v0.6] Convert messages into incremental change requests and reproducible handoffs" \
  --body "Closes #38. See PR description template in the executing-plans skill output for evidence sections (test output, roadmap-required scenario, manual verification notes, follow-up issue link)."
```
