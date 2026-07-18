# Plan and Build Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user send a chat message in Plan mode (proposal only, workspace untouched) or Build mode (may write to the workspace, gated on an approved plan or an explicit override), with the mode flowing into `TaskProfile` and the compiled prompt through the existing propagation path.

**Architecture:** New `Operation` fields (`approval`, `planOperationId`, `directExecution`) record the gate. A new `OperationService` turns a `(message, mode)` pair into a `WorkflowRun` + `Operation` without touching the existing whole-project pipeline. A new, small `ConversationOperationRunner` executes that one `AgentStep` by reusing `task-profiler`/`prompt-compiler`/`ExecutorRegistry`/`ArtifactStore` exactly as `workflow-orchestrator.ts` does today, but skips the multi-node graph engine and never touches `Project.status`/`currentRunId`. A new worker job type (`run-conversation-operation`) dispatches to it, parallel to the existing `run-project` type.

**Tech Stack:** TypeScript, Zod, Fastify, Vitest, Next.js (App Router) — matches the existing repo stack, no new dependencies.

## Global Constraints

- No new npm dependencies — every task reuses packages already installed in this monorepo.
- Every new/changed Zod schema is `.strict()` where the schema it extends is `.strict()`.
- `packages/orchestrator/src/workflow-orchestrator.ts` and `packages/orchestrator/src/project-service.ts` are NOT modified by this plan — the new execution path is fully separate.
- `Project.status`/`Project.currentRunId` are never written by any new code in this plan.
- Every task ends green on `npx vitest run <its test file(s)> --pool=threads --maxWorkers=1`.
- Design reference: `docs/superpowers/specs/2026-07-18-plan-build-modes-design.md`.

---

### Task 1: `Operation` approval/gating fields

**Files:**
- Modify: `packages/contracts/src/conversation.ts`
- Modify: `packages/contracts/src/conversation.test.ts`

**Interfaces:**
- Produces: `OperationApprovalSchema` / `OperationApproval` type; `Operation` gains optional `approval: OperationApproval`, `planOperationId: string`, `directExecution: boolean`. A `build` operation must carry exactly one of `planOperationId`/`directExecution`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/conversation.test.ts` (new `it` blocks inside the existing `describe('conversation aggregate contracts (#36)', ...)`, after the existing operation test):

```typescript
  it('records plan approval and build gating on an operation', () => {
    const plan = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      approval: { status: 'pending' as const },
      createdAt,
    };
    expect(OperationSchema.parse(plan)).toEqual(plan);

    const approved = {
      ...plan,
      approval: { status: 'approved' as const, decidedAt: createdAt, decidedBy: { kind: 'user' as const, id: 'ed' } },
    };
    expect(OperationSchema.parse(approved)).toEqual(approved);

    const buildFromPlan = {
      id: 'operation-2',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-2',
      kind: 'build' as const,
      idempotencyKey: 'b'.repeat(64),
      artifactReferences: [],
      planOperationId: plan.id,
      createdAt,
    };
    expect(OperationSchema.parse(buildFromPlan)).toEqual(buildFromPlan);

    const buildDirect = { ...buildFromPlan, id: 'operation-3', planOperationId: undefined, directExecution: true };
    expect(OperationSchema.parse(buildDirect)).toMatchObject({ directExecution: true });
  });

  it('rejects a build operation with neither or both plan gates', () => {
    const base = {
      id: 'operation-4',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-3',
      kind: 'build' as const,
      idempotencyKey: 'c'.repeat(64),
      artifactReferences: [],
      createdAt,
    };
    expect(() => OperationSchema.parse(base)).toThrow();
    expect(() =>
      OperationSchema.parse({ ...base, planOperationId: 'operation-1', directExecution: true }),
    ).toThrow();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/contracts/src/conversation.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `approval`/`planOperationId`/`directExecution` are not recognized by the `.strict()` schema (unrecognized key errors), and the "rejects" test fails because nothing throws yet.

- [ ] **Step 3: Implement the schema**

In `packages/contracts/src/conversation.ts`, change the import line and add the new schema + extend `OperationSchema`:

```typescript
import { z } from 'zod';
import { ActorRefSchema, JsonValueSchema, PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema, IdempotencyKeySchema } from './run.js';
```

Replace the existing `OperationSchema` block (currently lines 71-86) with:

```typescript
export const OperationApprovalSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']),
    decidedAt: z.string().datetime().optional(),
    decidedBy: ActorRefSchema.optional(),
  })
  .strict();
export type OperationApproval = z.infer<typeof OperationApprovalSchema>;

export const OperationSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    messageId: PathSegmentSchema,
    kind: OperationKindSchema,
    idempotencyKey: IdempotencyKeySchema,
    runId: PathSegmentSchema.optional(),
    changeRequestId: PathSegmentSchema.optional(),
    projectVersionId: PathSegmentSchema.optional(),
    artifactReferences: z.array(ArtifactReferenceSchema).default([]),
    approval: OperationApprovalSchema.optional(),
    planOperationId: PathSegmentSchema.optional(),
    directExecution: z.boolean().optional(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (operation.kind !== 'build') return;
    const hasPlan = operation.planOperationId !== undefined;
    const hasDirect = operation.directExecution === true;
    if (hasPlan === hasDirect) {
      ctx.addIssue({
        code: 'custom',
        path: ['planOperationId'],
        message: 'build operations require exactly one of planOperationId or directExecution',
      });
    }
  });
export type Operation = z.infer<typeof OperationSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/contracts/src/conversation.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (all tests in the file, including the pre-existing ones — the existing `'parses conversation operations for build and repair work'`-style test still passes because its fixture never sets `kind: 'build'` without a gate... check its `kind` — if it uses `kind: 'build'`, add `directExecution: true` to that existing fixture too so it keeps passing).

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts
git commit -m "feat(contracts): add plan approval and build gating fields to Operation"
```

---

### Task 2: `QueueJob` job-type widening + Start/Decide operation request contracts

**Files:**
- Modify: `packages/contracts/src/project.ts`
- Modify: `packages/contracts/src/project.test.ts`
- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/api.test.ts`

**Interfaces:**
- Consumes: `Operation` from Task 1.
- Produces: `QueueJobSchema.type` accepts `'run-project' | 'run-conversation-operation'`; `QueueJob.operationId?: string`. `StartOperationRequestSchema`/`StartOperationRequest` (`{kind: 'plan'|'build', planOperationId?, directExecution?}`), `StartOperationResponseSchema`, `DecideOperationRequestSchema`/`DecideOperationRequest` (`{action: 'approve'|'reject'}`), `DecideOperationResponseSchema`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/contracts/src/project.test.ts` (new top-level `describe`):

```typescript
describe('QueueJobSchema job types (#37)', () => {
  it('accepts both run-project and run-conversation-operation jobs', () => {
    const base = {
      id: 'job-1',
      projectId: 'project-1',
      workflowId: 'conversation-plan',
      attempts: 0,
      maxAttempts: 1,
      createdAt: '2026-07-18T12:00:00.000Z',
      availableAt: '2026-07-18T12:00:00.000Z',
      leaseEpoch: 0,
    };
    expect(
      QueueJobSchema.parse({ ...base, type: 'run-conversation-operation', runId: 'run-1', operationId: 'operation-1' }),
    ).toMatchObject({ type: 'run-conversation-operation', operationId: 'operation-1' });
    expect(QueueJobSchema.parse({ ...base, type: 'run-project', workflowId: 'web-app-v1' })).toMatchObject({
      type: 'run-project',
    });
    expect(() => QueueJobSchema.parse({ ...base, type: 'bogus' })).toThrow();
  });
});
```

Add `QueueJobSchema` to the existing import list at the top of `packages/contracts/src/project.test.ts`.

Add to `packages/contracts/src/api.test.ts` (new `it` inside `describe('conversation HTTP contracts (#36)', ...)`, and import `StartOperationRequestSchema`, `StartOperationResponseSchema`, `DecideOperationRequestSchema`, `DecideOperationResponseSchema` in the import list at the top):

```typescript
  it('parses start/decide operation requests and rejects ambiguous build gating', () => {
    expect(StartOperationRequestSchema.parse({ kind: 'plan' })).toEqual({ kind: 'plan' });
    expect(
      StartOperationRequestSchema.parse({ kind: 'build', planOperationId: 'operation-1' }),
    ).toMatchObject({ planOperationId: 'operation-1' });
    expect(
      StartOperationRequestSchema.parse({ kind: 'build', directExecution: true }),
    ).toMatchObject({ directExecution: true });
    expect(() => StartOperationRequestSchema.parse({ kind: 'build' })).toThrow();
    expect(() =>
      StartOperationRequestSchema.parse({
        kind: 'build',
        planOperationId: 'operation-1',
        directExecution: true,
      }),
    ).toThrow();
    expect(StartOperationResponseSchema.parse({ operation }).operation).toEqual(operation);

    expect(DecideOperationRequestSchema.parse({ action: 'approve' })).toEqual({ action: 'approve' });
    expect(DecideOperationResponseSchema.parse({ operation }).operation).toEqual(operation);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/contracts/src/project.test.ts packages/contracts/src/api.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `type: 'bogus'` currently would already fail (that's fine, that assertion should pass even before the change), but `type: 'run-conversation-operation'` fails against the current `z.literal('run-project')`, and `StartOperationRequestSchema` etc. don't exist yet (import error).

- [ ] **Step 3: Implement the schema changes**

In `packages/contracts/src/project.ts`, change the `QueueJobSchema.type`/add `operationId` (replace the existing block, currently lines 131-145):

```typescript
export const QueueJobSchema = z.object({
  id: PathSegmentSchema,
  type: z.enum(['run-project', 'run-conversation-operation']),
  projectId: PathSegmentSchema,
  workflowId: PathSegmentSchema,
  runId: PathSegmentSchema.optional(),
  operationId: PathSegmentSchema.optional(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: z.string().datetime(),
  availableAt: z.string().datetime(),
  lastError: z.string().optional(),
  leaseEpoch: z.number().int().nonnegative().default(0),
  lease: QueueLeaseSchema.optional(),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;
```

In `packages/contracts/src/api.ts`, add after the existing `CreateOperationResponseSchema` block:

```typescript
export const StartOperationRequestSchema = z
  .object({
    kind: z.enum(['plan', 'build']),
    planOperationId: PathSegmentSchema.optional(),
    directExecution: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.kind !== 'build') return;
    const hasPlan = input.planOperationId !== undefined;
    const hasDirect = input.directExecution === true;
    if (hasPlan === hasDirect) {
      ctx.addIssue({
        code: 'custom',
        path: ['planOperationId'],
        message: 'build requires exactly one of planOperationId or directExecution',
      });
    }
  });
export type StartOperationRequest = z.infer<typeof StartOperationRequestSchema>;

export const StartOperationResponseSchema = z.object({ operation: OperationSchema }).strict();
export type StartOperationResponse = z.infer<typeof StartOperationResponseSchema>;

export const DecideOperationRequestSchema = z
  .object({ action: z.enum(['approve', 'reject']) })
  .strict();
export type DecideOperationRequest = z.infer<typeof DecideOperationRequestSchema>;

export const DecideOperationResponseSchema = z.object({ operation: OperationSchema }).strict();
export type DecideOperationResponse = z.infer<typeof DecideOperationResponseSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/contracts/src/project.test.ts packages/contracts/src/api.test.ts --pool=threads --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/project.ts packages/contracts/src/project.test.ts packages/contracts/src/api.ts packages/contracts/src/api.test.ts
git commit -m "feat(contracts): add run-conversation-operation job type and start/decide operation requests"
```

---

### Task 3: `ConversationRepository.getOperation`/`updateOperation`

**Files:**
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/conversation-repository.ts`
- Modify: `packages/persistence/src/conversation-repository.test.ts`

**Interfaces:**
- Consumes: `Operation` (Task 1).
- Produces: `ConversationRepository.getOperation(projectId, operationId): Promise<Operation | null>`, `ConversationRepository.updateOperation(operation: Operation): Promise<Operation>` — both implemented by `FileConversationRepository`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/persistence/src/conversation-repository.test.ts` (find its existing `createOperation`-focused `describe`/`it` blocks and add these as new `it`s in the same `describe`; import nothing new — `NotFoundError` is already imported in that style elsewhere in the persistence package, add `import { NotFoundError } from '@agent-foundry/domain';` if not already present):

```typescript
  it('fetches a single operation by id and returns null when absent', async () => {
    const repo = new FileConversationRepository(dataDir);
    await repo.createConversation({ id: 'project-1', projectId: 'project-1', createdAt });
    const operation = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      createdAt,
    };
    await repo.createOperation(operation);

    expect(await repo.getOperation('project-1', 'operation-1')).toEqual(operation);
    expect(await repo.getOperation('project-1', 'missing')).toBeNull();
  });

  it('updates an existing operation in place and rejects an unknown id', async () => {
    const repo = new FileConversationRepository(dataDir);
    await repo.createConversation({ id: 'project-1', projectId: 'project-1', createdAt });
    const operation = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      approval: { status: 'pending' as const },
      createdAt,
    };
    await repo.createOperation(operation);

    const approved = { ...operation, approval: { status: 'approved' as const, decidedAt: createdAt } };
    const updated = await repo.updateOperation(approved);
    expect(updated).toEqual(approved);
    expect(await repo.getOperation('project-1', 'operation-1')).toEqual(approved);

    await expect(repo.updateOperation({ ...approved, id: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });
```

(Match the file's existing `dataDir`/`createdAt` setup fixtures — it already has a `beforeEach`/`afterEach` that creates a temp `dataDir` and a `createdAt` constant used by neighboring tests; reuse those, don't redeclare.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/persistence/src/conversation-repository.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `repo.getOperation`/`repo.updateOperation` are not functions yet.

- [ ] **Step 3: Implement**

In `packages/domain/src/ports.ts`, replace the `ConversationRepository` interface (currently lines 49-63):

```typescript
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
}
```

In `packages/persistence/src/conversation-repository.ts`, add `NotFoundError` to the existing `@agent-foundry/domain` import (it's already imported for other use in this file — confirm and keep a single import statement), then add two methods to `FileConversationRepository` right after `createOperation` (currently ending at line 158):

```typescript
  async getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    return (
      (await this.readOperations(projectId)).find((operation) => operation.id === operationId) ??
      null
    );
  }

  async updateOperation(operation: Operation): Promise<Operation> {
    const parsed = OperationSchema.parse(operation);
    return this.withLock(parsed.projectId, async () => {
      const operations = await this.readOperations(parsed.projectId);
      const index = operations.findIndex((item) => item.id === parsed.id);
      if (index === -1) throw new NotFoundError(`Operation ${parsed.id} not found`);
      operations[index] = parsed;
      await this.writeJsonLines(this.operationsPath(parsed.projectId), operations);
      return parsed;
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/persistence/src/conversation-repository.test.ts --pool=threads --maxWorkers=1`
Expected: PASS

Also run: `npx tsc -b --force --pretty false` — confirms no other `ConversationRepository` implementer (e.g. any in-memory test double outside this plan's own new files) breaks; if it does, this surfaces exactly where the interface change needs a matching stub, which Task 6/7's own test fakes will supply.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/ports.ts packages/persistence/src/conversation-repository.ts packages/persistence/src/conversation-repository.test.ts
git commit -m "feat(persistence): add getOperation/updateOperation to ConversationRepository"
```

---

### Task 4: Conversation step config (Plan/Build `AgentStep` builder)

**Files:**
- Create: `packages/orchestrator/src/conversation-step-config.ts`
- Create: `packages/orchestrator/src/conversation-step-config.test.ts`

**Interfaces:**
- Consumes: `Message`, `AgentStep` (contracts).
- Produces: `CONVERSATION_WORKFLOW_ID: Record<'plan' | 'build', string>`, `messageText(message: Message): string`, `buildConversationStep(input: {operationId: string; kind: 'plan' | 'build'; message: Message; planArtifact?: {content: unknown}}): AgentStep`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/orchestrator/src/conversation-step-config.test.ts
import { describe, expect, it } from 'vitest';
import type { Message } from '@agent-foundry/contracts';
import { ValidationError } from '@agent-foundry/domain';
import { buildConversationStep, CONVERSATION_WORKFLOW_ID, messageText } from './conversation-step-config.js';

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    sequence: 1,
    createdAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

describe('conversation-step-config', () => {
  it('extracts joined text content and rejects a textless message', () => {
    expect(messageText(message())).toBe('Add a dark mode toggle');
    expect(() =>
      messageText(message({ content: [{ type: 'data', value: { x: 1 } }] })),
    ).toThrow(ValidationError);
  });

  it('builds a non-mutating plan step from the message text', () => {
    const step = buildConversationStep({ operationId: 'operation-1', kind: 'plan', message: message() });
    expect(step).toMatchObject({
      id: 'conversation-plan-operation-1',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      outputArtifact: 'plan-proposal',
      mutatesWorkspace: false,
      instructions: 'Add a dark mode toggle',
    });
  });

  it('builds a mutating build step and appends an approved plan section when supplied', () => {
    const withoutPlan = buildConversationStep({ operationId: 'operation-2', kind: 'build', message: message() });
    expect(withoutPlan).toMatchObject({
      id: 'conversation-build-operation-2',
      role: 'developer',
      taskKind: 'implementation',
      outputArtifact: 'build-report',
      mutatesWorkspace: true,
      instructions: 'Add a dark mode toggle',
    });

    const withPlan = buildConversationStep({
      operationId: 'operation-3',
      kind: 'build',
      message: message(),
      planArtifact: { content: { schemaVersion: '1', summary: 'Toggle plan' } },
    });
    expect(withPlan.instructions).toContain('Add a dark mode toggle');
    expect(withPlan.instructions).toContain('Toggle plan');
  });

  it('names the synthetic workflow id per mode', () => {
    expect(CONVERSATION_WORKFLOW_ID).toEqual({ plan: 'conversation-plan', build: 'conversation-build' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/conversation-step-config.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module `./conversation-step-config.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/orchestrator/src/conversation-step-config.ts
import type { AgentStep, Message } from '@agent-foundry/contracts';
import { ValidationError } from '@agent-foundry/domain';

export const CONVERSATION_WORKFLOW_ID: Record<'plan' | 'build', string> = {
  plan: 'conversation-plan',
  build: 'conversation-build',
};

const STEP_BASE: Record<'plan' | 'build', Omit<AgentStep, 'id' | 'instructions'>> = {
  plan: {
    type: 'agent',
    role: 'planner',
    taskKind: 'planning',
    title: 'Chat plan proposal',
    outputArtifact: 'plan-proposal',
    inputArtifacts: [],
    mutatesWorkspace: false,
    harnessTags: [],
    profile: {},
    maxAttempts: 2,
  },
  build: {
    type: 'agent',
    role: 'developer',
    taskKind: 'implementation',
    title: 'Chat build execution',
    outputArtifact: 'build-report',
    inputArtifacts: [],
    mutatesWorkspace: true,
    harnessTags: [],
    profile: {},
    maxAttempts: 2,
  },
};

function isTextBlock(
  block: Message['content'][number],
): block is Extract<Message['content'][number], { type: 'text' }> {
  return block.type === 'text';
}

export function messageText(message: Message): string {
  const text = message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n\n');
  if (!text) throw new ValidationError(`Message ${message.id} has no text content to act on`);
  return text;
}

export function buildConversationStep(input: {
  operationId: string;
  kind: 'plan' | 'build';
  message: Message;
  planArtifact?: { content: unknown } | undefined;
}): AgentStep {
  const base = STEP_BASE[input.kind];
  const planSection = input.planArtifact
    ? `\n\n## Approved plan\n\n\`\`\`json\n${JSON.stringify(input.planArtifact.content, null, 2)}\n\`\`\`\n`
    : '';
  return {
    ...base,
    id: `conversation-${input.kind}-${input.operationId}`,
    instructions: `${messageText(input.message)}${planSection}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/conversation-step-config.test.ts --pool=threads --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/conversation-step-config.ts packages/orchestrator/src/conversation-step-config.test.ts
git commit -m "feat(orchestrator): add conversation plan/build step config builder"
```

---

### Task 5: `ConversationOperationRunner`

**Files:**
- Create: `packages/orchestrator/src/conversation-operation-runner.ts`
- Create: `packages/orchestrator/src/conversation-operation-runner.test.ts`

**Interfaces:**
- Consumes: `buildTaskProfile` (task-profiler.js, existing), `compileRequestMarkdown`/`compileCliPrompt` (prompt-compiler.js, existing), `buildConversationStep`/`CONVERSATION_WORKFLOW_ID`/`messageText` (Task 4), `ConversationRepository.getOperation`/`listMessages` (Task 3), `transitionWorkflowRun`/`transitionStepRun`/`transitionStepAttempt` (`@agent-foundry/domain`, existing).
- Produces: `class ConversationOperationRunner { constructor(runs, stepRuns, stepAttempts, artifacts, events, harness, router, metrics, executors, workspaces, conversations, clock, ids, options: {agentTimeoutMs: number}); run(projectId: string, runId: string, operationId: string): Promise<void>; }`. On success: `WorkflowRun.status === 'completed'`, one `StepRun`/`StepAttempt` `completed`/`succeeded`, an artifact named `operation-${operationId}` stored, workspace checkpoint+commit only when the step's `mutatesWorkspace` is true. On failure: `WorkflowRun.status === 'failed'` with a `RunError`, workspace rolled back if a checkpoint was taken, `run()` resolves (does not throw) so its caller (Task 8's `WorkerLoop`) acks the job instead of retrying a durably-recorded business failure.

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/orchestrator/src/conversation-operation-runner.test.ts
import { describe, expect, it } from 'vitest';
import type {
  ArtifactStore,
  Clock,
  ConversationRepository,
  EventStore,
  ExecutorRegistry,
  HarnessRepository,
  IdGenerator,
  MetricsRepository,
  ModelRouter,
  StepAttemptRepository,
  StepRunRepository,
  WorkflowRunRepository,
} from '@agent-foundry/domain';
import type { Conversation, Message, Operation, WorkflowRun } from '@agent-foundry/contracts';
import {
  ControllableExecutor,
  FakeWorkspaces,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryRuns,
  InMemoryStepAttempts,
  InMemoryStepRuns,
  MODELS,
} from './testing/harness.js';
import { ConversationOperationRunner } from './conversation-operation-runner.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-18T12:00:00.000Z');
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class MemoryConversations implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages: Message[] = [];
  private readonly operations: Operation[] = [];
  createConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.projectId, conversation);
    return Promise.resolve();
  }
  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(this.conversations.get(projectId) ?? null);
  }
  getSnapshot(projectId: string) {
    return Promise.resolve({
      conversation: this.conversations.get(projectId) ?? null,
      messages: this.messages.filter((m) => m.projectId === projectId),
      attachments: [],
      operations: this.operations.filter((o) => o.projectId === projectId),
    });
  }
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const stored = { ...message, sequence: this.messages.length + 1 };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }
  listMessages(projectId: string): Promise<Message[]> {
    return Promise.resolve(this.messages.filter((m) => m.projectId === projectId));
  }
  createAttachment(): Promise<never> {
    return Promise.reject(new Error('not used in this test'));
  }
  getAttachment(): Promise<null> {
    return Promise.resolve(null);
  }
  listAttachments(): Promise<never[]> {
    return Promise.resolve([]);
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
    this.operations[index] = operation;
    return Promise.resolve(operation);
  }
  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(this.operations.filter((o) => o.projectId === projectId));
  }
}

const harnessRepo: HarnessRepository = {
  select: () => Promise.resolve({ version: 'v1', files: [], combined: '' }),
  version: () => Promise.resolve('v1'),
};
const metrics: MetricsRepository = {
  get: () => Promise.resolve(null),
  record: () => Promise.resolve(),
  recordQuality: () => Promise.resolve(),
};
const router: ModelRouter = {
  route: (profile) =>
    Promise.resolve({
      routeId: 'route-1',
      createdAt: '2026-07-18T12:00:00.000Z',
      profile,
      selected: {
        model: MODELS[0]!,
        score: {
          capability: 1,
          context: 1,
          speed: 1,
          cost: 1,
          reliability: 1,
          historical: 1,
          tagAffinity: 1,
          estimatedCostUsd: 0,
          total: 1,
        },
      },
      fallbacks: [],
      rejected: [],
    }),
  catalog: () => Promise.resolve(MODELS),
};

function setup() {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    harnessRepo,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    new FixedClock(),
    new SequentialIds(),
    { agentTimeoutMs: 60_000 },
  );
  return { runs, stepRuns, stepAttempts, artifacts, events, workspaces, conversations, runner };
}

async function seed(
  conversations: MemoryConversations,
  runs: WorkflowRunRepository,
  kind: 'plan' | 'build',
): Promise<{ runId: string; operationId: string }> {
  await conversations.createConversation({ id: 'project-1', projectId: 'project-1', createdAt: '2026-07-18T12:00:00.000Z' });
  await conversations.appendMessage({
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  const runId = 'run-1';
  const operationId = 'operation-1';
  await runs.create({
    id: runId,
    projectId: 'project-1',
    workflowId: `conversation-${kind}`,
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
    kind,
    idempotencyKey: 'a'.repeat(64),
    runId,
    artifactReferences: [],
    ...(kind === 'plan' ? { approval: { status: 'pending' as const } } : { directExecution: true as const }),
    createdAt: '2026-07-18T12:00:00.000Z',
  });
  return { runId, operationId };
}

describe('ConversationOperationRunner', () => {
  it('completes a plan operation without touching the workspace', async () => {
    const { runs, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'plan');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.commits).toEqual([]);
    expect(await artifacts.getLatest('project-1', `operation-${operationId}`)).not.toBeNull();
  });

  it('completes a build operation and commits the touched workspace', async () => {
    const { runs, artifacts, workspaces, conversations, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    expect(await artifacts.getLatest('project-1', `operation-${operationId}`)).not.toBeNull();
  });

  it('marks the run failed and rolls back the checkpoint when the executor fails', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
    const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
    const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
    const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
    const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
    const conversations = new MemoryConversations();
    const executor = new ControllableExecutor(
      { 'conversation-build-operation-1': { kind: 'fail-always', error: () => new Error('boom') } },
      workspaces,
    );
    const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
    const runner = new ConversationOperationRunner(
      runs,
      stepRuns,
      stepAttempts,
      artifacts,
      events,
      harnessRepo,
      router,
      metrics,
      executors,
      workspaces,
      conversations,
      new FixedClock(),
      new SequentialIds(),
      { agentTimeoutMs: 60_000 },
    );
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    const run = (await runs.get(runId)) as WorkflowRun;
    expect(run.status).toBe('failed');
    expect(run.error?.message).toContain('boom');
    expect(workspaces.rollbacks).toHaveLength(1);
    expect(workspaces.commits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module `./conversation-operation-runner.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/orchestrator/src/conversation-operation-runner.ts
import type {
  AgentExecutionRequest,
  ArtifactReference,
  Message,
  Operation,
  RunError,
  StepAttempt,
  StepRun,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { AGENT_ARTIFACT_JSON_SCHEMA } from '@agent-foundry/contracts';
import {
  ExecutionError,
  NotFoundError,
  errorMessage,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';
import { CONVERSATION_WORKFLOW_ID, buildConversationStep } from './conversation-step-config.js';

export interface ConversationOperationRunnerOptions {
  agentTimeoutMs: number;
}

function toArtifactReference(artifact: StoredArtifact): ArtifactReference {
  return {
    name: artifact.metadata.name,
    revision: artifact.metadata.revision,
    sha256: artifact.metadata.sha256,
  };
}

function toRunError(error: unknown): RunError {
  const details = error instanceof ExecutionError ? error.details : {};
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: errorMessage(error),
    ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
  };
}

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
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: ConversationOperationRunnerOptions,
  ) {}

  async run(projectId: string, runId: string, operationId: string): Promise<void> {
    const initialRun = await this.requireRun(runId);
    const operation = await this.requireOperation(projectId, operationId);
    const kind: 'plan' | 'build' = operation.kind === 'build' ? 'build' : 'plan';
    const message = await this.requireMessage(projectId, operation.messageId);
    const planArtifact = await this.loadPlanArtifact(projectId, operation);
    const step = buildConversationStep({ operationId, kind, message, planArtifact });

    let runState = await this.runs.update(
      transitionWorkflowRun(initialRun, 'running', this.clock.now()),
      initialRun.version,
    );

    const stepTimestamp = this.clock.now().toISOString();
    let stepRun: StepRun = {
      id: this.ids.next(),
      runId,
      nodeId: step.id,
      stepId: step.id,
      stepType: 'agent',
      status: 'pending',
      version: 1,
      createdAt: stepTimestamp,
      updatedAt: stepTimestamp,
    };
    await this.stepRuns.create(stepRun);
    stepRun = await this.stepRuns.update(
      transitionStepRun(stepRun, 'running', this.clock.now()),
      stepRun.version,
    );

    let checkpoint: string | null = null;
    let attempt: StepAttempt | undefined;
    try {
      const harness = await this.harness.select({
        role: step.role,
        taskKind: step.taskKind,
        stack: 'conversation',
        tags: step.harnessTags,
      });
      const profile = buildTaskProfile({ step, harness, artifacts: [], policy: undefined });
      const route = await this.router.route(profile);
      checkpoint = step.mutatesWorkspace
        ? await this.workspaces.checkpoint(projectId, `${step.id}-${runId}`)
        : null;

      const attemptTimestamp = this.clock.now().toISOString();
      attempt = {
        id: this.ids.next(),
        runId,
        stepRunId: stepRun.id,
        sequence: 1,
        executorKind: 'agent',
        provider: route.selected.model.provider,
        model: route.selected.model.model || route.selected.model.id,
        modelId: route.selected.model.id,
        status: 'running',
        version: 1,
        createdAt: attemptTimestamp,
        updatedAt: attemptTimestamp,
        startedAt: attemptTimestamp,
        ...(checkpoint ? { checkpoint } : {}),
        routeDecision: route,
        context: {
          projectId,
          workflowId: CONVERSATION_WORKFLOW_ID[kind],
          nodeId: step.id,
          stepId: step.id,
        },
        inputArtifacts: [],
        outputArtifacts: [],
      };
      await this.stepAttempts.create(attempt);

      const requestMarkdown = compileRequestMarkdown({
        projectId,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        workflowId: CONVERSATION_WORKFLOW_ID[kind],
        stack: 'conversation',
        step,
        harness,
        artifacts: [],
        workspacePath: this.workspaces.workspacePath(projectId),
      });
      await this.workspaces.writeRunContext({
        projectId,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        requestMarkdown,
        outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
      });

      const request: AgentExecutionRequest = {
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        projectId,
        stepId: step.id,
        role: step.role,
        taskKind: step.taskKind,
        provider: route.selected.model.provider,
        model: route.selected.model.model,
        prompt: compileCliPrompt(runId, stepRun.id, attempt.id),
        cwd: this.workspaces.workspacePath(projectId),
        mutatesWorkspace: step.mutatesWorkspace,
        timeoutMs: this.options.agentTimeoutMs,
        outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
      };
      const result = await this.executors.get(route.selected.model.provider).execute(request);

      const commit = step.mutatesWorkspace
        ? await this.workspaces.commit(projectId, `conversation(${kind}): ${step.title}`)
        : null;
      const executionRoute = { ...route, executed: route.selected };
      const artifact = await this.artifacts.put({
        projectId,
        name: `operation-${operationId}`,
        content: result.output,
        createdBy: `${step.role}:${route.selected.model.provider}/${route.selected.model.model || 'default'}`,
        runId,
        stepRunId: stepRun.id,
        attemptId: attempt.id,
        routeDecision: executionRoute,
      });

      await this.stepAttempts.update(
        transitionStepAttempt(attempt, 'succeeded', this.clock.now(), {
          durationMs: result.durationMs,
          ...(commit ? { commit } : {}),
          routeDecision: executionRoute,
          outputArtifacts: [toArtifactReference(artifact)],
        }),
        attempt.version,
      );
      await this.stepRuns.update(
        transitionStepRun(stepRun, 'completed', this.clock.now()),
        stepRun.version,
      );
      runState = await this.runs.update(
        transitionWorkflowRun(runState, 'completed', this.clock.now()),
        runState.version,
      );
      await this.metrics.record({
        modelId: route.selected.model.id,
        taskKind: step.taskKind,
        role: step.role,
        success: true,
        durationMs: result.durationMs,
      });
      await this.events.append({
        id: this.ids.next(),
        projectId,
        type: 'operation.completed',
        message: `${step.title} completed.`,
        createdAt: this.clock.now().toISOString(),
        data: { operationId, runId, kind },
      });
    } catch (error) {
      if (checkpoint) await this.workspaces.rollback(projectId, checkpoint);
      const runErr = toRunError(error);
      if (attempt && attempt.status === 'running') {
        await this.stepAttempts.update(
          transitionStepAttempt(attempt, 'failed', this.clock.now(), { error: runErr }),
          attempt.version,
        );
      }
      await this.stepRuns.update(
        transitionStepRun(stepRun, 'failed', this.clock.now(), { error: runErr }),
        stepRun.version,
      );
      runState = await this.runs.update(
        transitionWorkflowRun(runState, 'failed', this.clock.now(), { error: runErr }),
        runState.version,
      );
      await this.events.append({
        id: this.ids.next(),
        projectId,
        type: 'operation.failed',
        message: errorMessage(error),
        createdAt: this.clock.now().toISOString(),
        data: { operationId, runId, kind },
      });
    }
  }

  private async requireRun(runId: string): Promise<WorkflowRun> {
    const run = await this.runs.get(runId);
    if (!run) throw new NotFoundError(`Workflow run ${runId} not found`);
    return run;
  }

  private async requireOperation(projectId: string, operationId: string): Promise<Operation> {
    const operation = await this.conversations.getOperation(projectId, operationId);
    if (!operation) throw new NotFoundError(`Operation ${operationId} not found`);
    return operation;
  }

  private async requireMessage(projectId: string, messageId: string): Promise<Message> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);
    return message;
  }

  private async loadPlanArtifact(
    projectId: string,
    operation: Operation,
  ): Promise<{ content: unknown } | undefined> {
    if (operation.kind !== 'build' || !operation.planOperationId) return undefined;
    const planOperation = await this.conversations.getOperation(projectId, operation.planOperationId);
    const reference = planOperation?.artifactReferences[0];
    if (!reference) return undefined;
    const artifact = await this.artifacts.getRevision(projectId, reference.name, reference.revision);
    return artifact ? { content: artifact.content } : undefined;
  }
}
```

Check `ProjectEvent` requires a `type` field constrained to a known string union — if `packages/contracts/src/project.ts`'s `ProjectEventSchema.type` is a free-form `z.string()`, the two literal strings above (`'operation.completed'`/`'operation.failed'`) just work; if it's a closed `z.enum([...])`, add both literals to that enum as part of this step (grep `ProjectEventSchema` in `packages/contracts/src/project.ts` before writing this file — if it's an enum, extend it there and note the extra file in this task's **Files** list).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/conversation-operation-runner.ts packages/orchestrator/src/conversation-operation-runner.test.ts
git commit -m "feat(orchestrator): add ConversationOperationRunner for single-step plan/build execution"
```

---

### Task 6: `OperationService.start()`

**Files:**
- Create: `packages/orchestrator/src/operation-service.ts`
- Create: `packages/orchestrator/src/operation-service.test.ts`

**Interfaces:**
- Consumes: `StartOperationRequest` (Task 2), `CONVERSATION_WORKFLOW_ID` (Task 4), `ConversationRepository.getOperation`/`createOperation` (Task 3), `JobQueue.enqueue` (existing).
- Produces: `class OperationService { constructor(conversations, runs, queue, artifacts, clock, ids); start(projectId, messageId, input: StartOperationRequest): Promise<Operation>; }` (the `decide` method is added in Task 7, same file/class).

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/orchestrator/src/operation-service.test.ts
import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Operation, StoredArtifact, WorkflowRun } from '@agent-foundry/contracts';
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
import { OperationService } from './operation-service.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-18T12:00:00.000Z');
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class MemoryConversations implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  readonly messages: Message[] = [];
  readonly operations: Operation[] = [];
  createConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.projectId, conversation);
    return Promise.resolve();
  }
  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(this.conversations.get(projectId) ?? null);
  }
  getSnapshot(projectId: string) {
    return Promise.resolve({
      conversation: this.conversations.get(projectId) ?? null,
      messages: this.messages,
      attachments: [],
      operations: this.operations,
    });
  }
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const stored = { ...message, sequence: this.messages.length + 1 };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }
  listMessages(projectId: string): Promise<Message[]> {
    return Promise.resolve(this.messages.filter((m) => m.projectId === projectId));
  }
  createAttachment(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  getAttachment(): Promise<null> {
    return Promise.resolve(null);
  }
  listAttachments(): Promise<never[]> {
    return Promise.resolve([]);
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
    this.operations[index] = operation;
    return Promise.resolve(operation);
  }
  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(this.operations.filter((o) => o.projectId === projectId));
  }
}

class MemoryRuns implements WorkflowRunRepository {
  readonly store = new Map<string, WorkflowRun>();
  create(run: WorkflowRun): Promise<void> {
    this.store.set(run.id, run);
    return Promise.resolve();
  }
  get(runId: string): Promise<WorkflowRun | null> {
    return Promise.resolve(this.store.get(runId) ?? null);
  }
  list(): Promise<WorkflowRun[]> {
    return Promise.resolve([...this.store.values()]);
  }
  update(run: WorkflowRun): Promise<WorkflowRun> {
    this.store.set(run.id, run);
    return Promise.resolve(run);
  }
}

class MemoryQueue implements JobQueue {
  readonly enqueued: Array<Parameters<JobQueue['enqueue']>[0]> = [];
  enqueue(job: Parameters<JobQueue['enqueue']>[0]): Promise<void> {
    this.enqueued.push(job);
    return Promise.resolve();
  }
  claim(): Promise<null> {
    return Promise.resolve(null);
  }
  heartbeat(job: Parameters<JobQueue['enqueue']>[0]): Promise<Parameters<JobQueue['enqueue']>[0]> {
    return Promise.resolve(job);
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  nack(): Promise<void> {
    return Promise.resolve();
  }
  reapExpired(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function noArtifacts(): ArtifactStore {
  return {
    put: () => Promise.reject(new Error('not used in start()')),
    putBlob: () => Promise.reject(new Error('not used')),
    getBlobStream: () => Promise.resolve(null),
    getLatest: () => Promise.resolve(null),
    getRevision: () => Promise.resolve(null),
    listLatest: () => Promise.resolve([]),
    listMetadata: () => Promise.resolve([]),
  };
}

async function seedMessage(conversations: MemoryConversations, projectId = 'project-1') {
  await conversations.createConversation({ id: projectId, projectId, createdAt: '2026-07-18T12:00:00.000Z' });
  return conversations.appendMessage({
    id: 'message-1',
    projectId,
    conversationId: projectId,
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle' }],
    createdAt: '2026-07-18T12:00:00.000Z',
  });
}

describe('OperationService.start', () => {
  it('creates a queued plan operation, run, and job', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());

    const operation = await service.start('project-1', message.id, { kind: 'plan' });

    expect(operation).toMatchObject({ kind: 'plan', approval: { status: 'pending' } });
    expect(operation.runId).toBeDefined();
    expect((await runs.get(operation.runId!))?.status).toBe('queued');
    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0]).toMatchObject({
      type: 'run-conversation-operation',
      operationId: operation.id,
      runId: operation.runId,
    });
  });

  it('rejects a build request with neither planOperationId nor directExecution', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());

    await expect(service.start('project-1', message.id, { kind: 'build' } as never)).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects a build referencing a plan that is not approved', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(
      service.start('project-1', message.id, { kind: 'build', planOperationId: plan.id }),
    ).rejects.toThrow(ValidationError);
  });

  it('copies the approved plan artifact references onto the build operation', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const reference = { name: 'plan-proposal', revision: 1, sha256: 'a'.repeat(64) };
    await conversations.updateOperation({
      ...plan,
      approval: { status: 'approved', decidedAt: '2026-07-18T12:05:00.000Z' },
      artifactReferences: [reference],
    });

    const build = await service.start('project-1', message.id, { kind: 'build', planOperationId: plan.id });

    expect(build.artifactReferences).toEqual([reference]);
  });

  it('creates a direct-execution build operation without a plan', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());

    const build = await service.start('project-1', message.id, { kind: 'build', directExecution: true });

    expect(build).toMatchObject({ kind: 'build', directExecution: true, artifactReferences: [] });
  });

  it('rejects an unknown message', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());

    await expect(service.start('project-1', 'missing', { kind: 'plan' })).rejects.toThrow(NotFoundError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/operation-service.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — module `./operation-service.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/orchestrator/src/operation-service.ts
import { createHash } from 'node:crypto';
import type { Operation, StartOperationRequest, WorkflowRun } from '@agent-foundry/contracts';
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

export class OperationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly queue: JobQueue,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

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

  protected idempotencyKey(operationId: string, runId: string): string {
    return createHash('sha256').update(`${operationId}:${runId}`).digest('hex');
  }
}
```

Note `artifacts` is threaded through the constructor now even though `start()` doesn't use it — Task 7 adds `decide()` to this same class and uses it there; wiring it in this step avoids re-touching every call site twice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/operation-service.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/operation-service.ts packages/orchestrator/src/operation-service.test.ts
git commit -m "feat(orchestrator): add OperationService.start for plan/build operations"
```

---

### Task 7: `OperationService.decide()`

**Files:**
- Modify: `packages/orchestrator/src/operation-service.ts`
- Modify: `packages/orchestrator/src/operation-service.test.ts`

**Interfaces:**
- Produces: `OperationService.decide(projectId: string, operationId: string, action: 'approve' | 'reject'): Promise<Operation>`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/orchestrator/src/operation-service.test.ts` (new `describe`, reusing the fixtures/classes already defined above in the same file):

```typescript
describe('OperationService.decide', () => {
  async function startAndCompletePlan(
    conversations: MemoryConversations,
    runs: MemoryRuns,
    queue: MemoryQueue,
    artifacts: ArtifactStore,
  ) {
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, artifacts, new FixedClock(), new SequentialIds());
    const plan = await service.start('project-1', message.id, { kind: 'plan' });
    const run = (await runs.get(plan.runId!))!;
    await runs.update({ ...run, status: 'running' });
    await runs.update({ ...run, status: 'completed' });
    return { service, plan };
  }

  it('rejects deciding a plan whose run has not completed', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());
    const plan = await service.start('project-1', message.id, { kind: 'plan' });

    await expect(service.decide('project-1', plan.id, 'approve')).rejects.toThrow(ValidationError);
  });

  it('approving derives artifactReferences from the completed run artifact', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const artifacts: ArtifactStore = {
      put: () => Promise.reject(new Error('not used')),
      putBlob: () => Promise.reject(new Error('not used')),
      getBlobStream: () => Promise.resolve(null),
      getLatest: (projectId, name) =>
        Promise.resolve({
          metadata: {
            projectId,
            name,
            revision: 1,
            contentType: 'application/json',
            createdAt: '2026-07-18T12:00:00.000Z',
            createdBy: 'planner:mock/mock',
            sha256: 'b'.repeat(64),
          },
          content: { schemaVersion: '1', summary: 'toggle plan' },
        }),
      getRevision: () => Promise.resolve(null),
      listLatest: () => Promise.resolve([]),
      listMetadata: () => Promise.resolve([]),
    };
    const { service, plan } = await startAndCompletePlan(conversations, runs, queue, artifacts);

    const approved = await service.decide('project-1', plan.id, 'approve');

    expect(approved.approval).toMatchObject({ status: 'approved' });
    expect(approved.artifactReferences).toEqual([
      { name: `operation-${plan.id}`, revision: 1, sha256: 'b'.repeat(64) },
    ]);
  });

  it('rejecting sets approval.status without touching artifactReferences', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const { service, plan } = await startAndCompletePlan(conversations, runs, queue, noArtifacts());

    const rejected = await service.decide('project-1', plan.id, 'reject');

    expect(rejected.approval).toMatchObject({ status: 'rejected' });
    expect(rejected.artifactReferences).toEqual([]);
  });

  it('rejects deciding a non-plan operation', async () => {
    const conversations = new MemoryConversations();
    const runs = new MemoryRuns();
    const queue = new MemoryQueue();
    const message = await seedMessage(conversations);
    const service = new OperationService(conversations, runs, queue, noArtifacts(), new FixedClock(), new SequentialIds());
    const build = await service.start('project-1', message.id, { kind: 'build', directExecution: true });

    await expect(service.decide('project-1', build.id, 'approve')).rejects.toThrow(ValidationError);
  });
});
```

Add `ValidationError` and `ArtifactStore` to the existing top-of-file imports if not already present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/operation-service.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `service.decide` is not a function.

- [ ] **Step 3: Implement**

Add to the `OperationService` class in `packages/orchestrator/src/operation-service.ts`, after `start()`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/operation-service.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (10 tests total in the file)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/operation-service.ts packages/orchestrator/src/operation-service.test.ts
git commit -m "feat(orchestrator): add OperationService.decide for plan approval"
```

---

### Task 8: `WorkerLoop` job-type dispatch

**Files:**
- Modify: `packages/orchestrator/src/worker-loop.ts`
- Modify: `packages/orchestrator/src/worker-loop.test.ts`

**Interfaces:**
- Consumes: `ConversationOperationRunner` (Task 5).
- Produces: `new WorkerLoop(queue, orchestrator, operationRunner, options)` — 3rd positional constructor argument added; dispatches `runOnce()` by `job.type`.

- [ ] **Step 1: Update the failing tests**

In `packages/orchestrator/src/worker-loop.test.ts`, add near the top (after the existing `fakeQueue` helper):

```typescript
function fakeOperationRunner(run: (projectId: string, runId: string, operationId: string) => Promise<void> = () => Promise.resolve()) {
  return { run } as unknown as import('./conversation-operation-runner.js').ConversationOperationRunner;
}
```

Update all four `new WorkerLoop(queue, orchestrator, {` call sites (lines ~77, ~111, ~140, ~164) to insert the new argument, e.g. the first one:

```typescript
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
```

(apply the identical one-line insertion — `fakeOperationRunner(),` before the options object — at each of the other three call sites in the file).

Add one new test at the end of the top-level `describe` block:

```typescript
  it('dispatches a run-conversation-operation job to the operation runner, not runProject', async () => {
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValueOnce(job({ type: 'run-conversation-operation', runId: 'run-1', operationId: 'operation-1' })).mockResolvedValue(null) });
    const runProject = vi.fn().mockResolvedValue(undefined);
    const orchestrator = { runProject } as unknown as WorkflowOrchestrator;
    const run = vi.fn().mockResolvedValue(undefined);
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(run), {
      workerId: 'worker-a',
      pollIntervalMs: 10,
    });

    await worker.runOnce();

    expect(run).toHaveBeenCalledWith('project-1', 'run-1', 'operation-1');
    expect(runProject).not.toHaveBeenCalled();
    expect(queue.ack).toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/worker-loop.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `WorkerLoop` constructor doesn't accept/use a 3rd `operationRunner` argument yet (TS error on the extra arg once implemented as a positional change makes the OLD 3-arg calls fail type-check; before Step 3, the new test's `run` assertion fails because `runOnce()` still unconditionally calls `runProject`).

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/worker-loop.ts`, add the import and change the constructor + `runOnce`:

```typescript
import type { QueueJob } from '@agent-foundry/contracts';
import type { JobQueue } from '@agent-foundry/domain';
import { errorMessage } from '@agent-foundry/domain';
import type { ConversationOperationRunner } from './conversation-operation-runner.js';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';
```

```typescript
  constructor(
    private readonly queue: JobQueue,
    private readonly orchestrator: WorkflowOrchestrator,
    private readonly operationRunner: ConversationOperationRunner,
    private readonly options: WorkerLoopOptions,
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim(this.options.workerId);
    if (!job) return false;

    const state: HeartbeatState = { job, leaseLost: false };
    const stopHeartbeat = this.startHeartbeat(state);

    try {
      if (job.type === 'run-project') {
        await this.orchestrator.runProject(job.projectId, job.workflowId, job.runId);
      } else {
        if (!job.runId || !job.operationId) {
          throw new Error(`run-conversation-operation job ${job.id} is missing runId/operationId`);
        }
        await this.operationRunner.run(job.projectId, job.runId, job.operationId);
      }
      stopHeartbeat();
      if (!state.leaseLost) await this.queue.ack(state.job, this.options.workerId);
    } catch (error) {
      stopHeartbeat();
      if (!state.leaseLost) {
        await this.queue.nack(
          state.job,
          this.options.workerId,
          error instanceof Error ? error : new Error(errorMessage(error)),
        );
      }
    }
    return true;
  }
```

(Everything else in the file — `start`, `stop`, `startHeartbeat`, `sleep` — is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/worker-loop.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/worker-loop.ts packages/orchestrator/src/worker-loop.test.ts
git commit -m "feat(orchestrator): dispatch WorkerLoop jobs by type to the conversation operation runner"
```

---

### Task 9: Wire `OperationService`/`ConversationOperationRunner` into the runtime

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**
- Consumes: `OperationService` (Task 6/7), `ConversationOperationRunner` (Task 5).
- Produces: `Runtime.operationService: OperationService`, `Runtime.operationRunner: ConversationOperationRunner` — both constructed and returned from `createRuntime()`.

- [ ] **Step 1: There is no isolated failing test for wiring** — this task is verified by the full package build/typecheck plus Task 10's differential test (which exercises this wiring end-to-end through the API in Task 11). Proceed straight to implementation; Step 4 below is the verification step for this task.

- [ ] **Step 2: (skipped — see Step 1)**

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/index.ts`, add one line:

```typescript
export * from './conversation-step-config.js';
export * from './conversation-operation-runner.js';
export * from './operation-service.js';
```

In `packages/composition/src/runtime.ts`:

1. Add `ConversationOperationRunner` and `OperationService` to the existing `@agent-foundry/orchestrator` import list (alongside `ConversationService`, `ProjectService`, etc.).
2. Add two fields to the `Runtime` interface: `operationRunner: ConversationOperationRunner;` and `operationService: OperationService;`.
3. After the existing `const conversationService = new ConversationService(...)` line, add:

```typescript
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
    clock,
    ids,
    { agentTimeoutMs: config.agentTimeoutMs },
  );
  const operationService = new OperationService(conversations, runs, queue, artifacts, clock, ids);
```

4. Change the `WorkerLoop` construction line to pass `operationRunner` as the 3rd argument:

```typescript
  const worker = new WorkerLoop(queue, orchestrator, operationRunner, {
    workerId: config.workerId,
    pollIntervalMs: config.workerPollIntervalMs,
    heartbeatIntervalMs: config.queueHeartbeatIntervalMs,
  });
```

5. Add `operationRunner` and `operationService` to the object literal returned at the end of `createRuntime`.

- [ ] **Step 4: Verify the whole package graph still builds**

Run: `npm run build:packages` (from repo root)
Expected: succeeds with no TypeScript errors — this is the only feedback loop for a pure-wiring task; a mistyped field name or missing constructor argument fails here.

Also run: `npx vitest run packages/orchestrator/src/worker-loop.test.ts packages/orchestrator/src/operation-service.test.ts packages/orchestrator/src/conversation-operation-runner.test.ts --pool=threads --maxWorkers=1`
Expected: PASS (confirms nothing in Tasks 5-8 regressed from the export changes)

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/index.ts packages/composition/src/runtime.ts
git commit -m "feat(composition): wire OperationService and ConversationOperationRunner into the runtime"
```

---

### Task 10: Required differential test — identical message, Plan vs Build

**Files:**
- Create: `packages/orchestrator/src/plan-build-modes.test.ts`

**Interfaces:**
- Consumes: `OperationService` (Task 6/7), `ConversationOperationRunner` (Task 5), testing fakes from `./testing/harness.js` (existing) — same composition pattern as Task 5's own test file.

This is the literal roadmap-required test (`planning/roadmap-spec.json`'s `v06-plan-build-modes.tests`): *"Mensagem idêntica em Plan e Build gera side effects diferentes"* (identical message in Plan and Build produces different side effects). It drives the exact same message text through `OperationService.start()` + `ConversationOperationRunner.run()` once with `kind: 'plan'` and once with `kind: 'build', directExecution: true`, and asserts the workspace is untouched in the first case and committed-to in the second.

- [ ] **Step 1: Write the test**

```typescript
// packages/orchestrator/src/plan-build-modes.test.ts
import { describe, expect, it } from 'vitest';
import type { Conversation, Message, Operation, WorkflowRun } from '@agent-foundry/contracts';
import {
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import {
  ControllableExecutor,
  FakeWorkspaces,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryRuns,
  InMemoryStepAttempts,
  InMemoryStepRuns,
  MODELS,
} from './testing/harness.js';
import { ConversationOperationRunner } from './conversation-operation-runner.js';
import { OperationService } from './operation-service.js';

class FixedClock implements Clock {
  private tick = 0;
  now(): Date {
    this.tick += 1;
    return new Date(2026, 6, 18, 12, 0, this.tick);
  }
}

class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `id-${String(this.counter).padStart(4, '0')}`;
  }
}

class MemoryConversations implements ConversationRepository {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages: Message[] = [];
  private readonly operations: Operation[] = [];
  createConversation(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.projectId, conversation);
    return Promise.resolve();
  }
  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(this.conversations.get(projectId) ?? null);
  }
  getSnapshot(projectId: string) {
    return Promise.resolve({
      conversation: this.conversations.get(projectId) ?? null,
      messages: this.messages.filter((m) => m.projectId === projectId),
      attachments: [],
      operations: this.operations.filter((o) => o.projectId === projectId),
    });
  }
  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const stored = { ...message, sequence: this.messages.length + 1 };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }
  listMessages(projectId: string): Promise<Message[]> {
    return Promise.resolve(this.messages.filter((m) => m.projectId === projectId));
  }
  createAttachment(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  getAttachment(): Promise<null> {
    return Promise.resolve(null);
  }
  listAttachments(): Promise<never[]> {
    return Promise.resolve([]);
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
    this.operations[index] = operation;
    return Promise.resolve(operation);
  }
  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(this.operations.filter((o) => o.projectId === projectId));
  }
}

class MemoryQueue implements JobQueue {
  enqueue(): Promise<void> {
    return Promise.resolve();
  }
  claim(): Promise<null> {
    return Promise.resolve(null);
  }
  heartbeat(job: never): Promise<never> {
    return Promise.resolve(job);
  }
  ack(): Promise<void> {
    return Promise.resolve();
  }
  nack(): Promise<void> {
    return Promise.resolve();
  }
  reapExpired(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

const harnessRepo: HarnessRepository = {
  select: () => Promise.resolve({ version: 'v1', files: [], combined: '' }),
  version: () => Promise.resolve('v1'),
};
const metrics: MetricsRepository = {
  get: () => Promise.resolve(null),
  record: () => Promise.resolve(),
  recordQuality: () => Promise.resolve(),
};
const router: ModelRouter = {
  route: (profile) =>
    Promise.resolve({
      routeId: 'route-1',
      createdAt: '2026-07-18T12:00:00.000Z',
      profile,
      selected: {
        model: MODELS[0]!,
        score: {
          capability: 1,
          context: 1,
          speed: 1,
          cost: 1,
          reliability: 1,
          historical: 1,
          tagAffinity: 1,
          estimatedCostUsd: 0,
          total: 1,
        },
      },
      fallbacks: [],
      rejected: [],
    }),
  catalog: () => Promise.resolve(MODELS),
};

async function runOperation(kind: 'plan' | 'build') {
  const conversations = new MemoryConversations();
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const workspaces = new FakeWorkspaces({ on: true });
  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = { get: () => executor, health: () => Promise.resolve([]) };
  const clock = new FixedClock();
  const ids = new SequentialIds();

  await conversations.createConversation({ id: 'project-1', projectId: 'project-1', createdAt: clock.now().toISOString() });
  const message = await conversations.appendMessage({
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Add a dark mode toggle to settings' }],
    createdAt: clock.now().toISOString(),
  });

  const operationService = new OperationService(conversations, runs, new MemoryQueue(), artifacts, clock, ids);
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    harnessRepo,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    clock,
    ids,
    { agentTimeoutMs: 60_000 },
  );

  const operation = await operationService.start(
    'project-1',
    message.id,
    kind === 'plan' ? { kind: 'plan' } : { kind: 'build', directExecution: true },
  );
  await runner.run('project-1', operation.runId!, operation.id);

  return { run: (await runs.get(operation.runId!))!, workspaces };
}

describe('Plan vs Build modes (#37)', () => {
  it('produces different workspace side effects for the identical message', async () => {
    const plan = await runOperation('plan');
    const build = await runOperation('build');

    expect(plan.run.status).toBe('completed');
    expect(build.run.status).toBe('completed');

    expect(plan.workspaces.checkpoints).toEqual([]);
    expect(plan.workspaces.commits).toEqual([]);

    expect(build.workspaces.checkpoints).toHaveLength(1);
    expect(build.workspaces.commits).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/plan-build-modes.test.ts --pool=threads --maxWorkers=1`
Expected: at this point in the plan (Tasks 1-9 already implemented) this test should already PASS — this task adds the test as the plan's dedicated, roadmap-traceable proof, not new production code. If it fails, it means one of Tasks 5-9 has a defect; fix that task's implementation, not this test, before proceeding.

- [ ] **Step 3: (no implementation step — this task is test-only, validating Tasks 1-9)**

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/plan-build-modes.test.ts --pool=threads --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/plan-build-modes.test.ts
git commit -m "test(orchestrator): prove identical message differs in side effects between plan and build modes"
```

---

### Task 11: API routes — start/decide operation

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/conversation.test.ts`

**Interfaces:**
- Consumes: `runtime.operationService` (Task 9), `StartOperationRequestSchema`/`DecideOperationRequestSchema` (Task 2).
- Produces: `POST /projects/:projectId/conversation/messages/:messageId/operations` now dispatches `kind: 'plan'|'build'` to `operationService.start`, other kinds keep the existing `conversationService.createOperation` path unchanged; new `POST /projects/:projectId/conversation/operations/:operationId/decide`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/src/conversation.test.ts` (new `it`s inside the existing `describe('conversation API', ...)`):

```typescript
  it('starts a plan operation, blocks an ungated build, and allows an explicit direct build', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const message = await createMessage(baseUrl, projectId, 'Add a dark mode toggle');
    const opsPath = `/projects/${projectId}/conversation/messages/${message.id}/operations`;

    const planResponse = await post(baseUrl, opsPath, { kind: 'plan' });
    expect(planResponse.status).toBe(201);
    const { operation: plan } = (await planResponse.json()) as { operation: { id: string; runId: string } };
    expect(plan.runId).toBeDefined();

    const ungatedBuild = await post(baseUrl, opsPath, { kind: 'build' });
    expect(ungatedBuild.status).toBe(400);

    const decideBeforeCompletion = await post(
      baseUrl,
      `/projects/${projectId}/conversation/operations/${plan.id}/decide`,
      { action: 'approve' },
    );
    expect(decideBeforeCompletion.status).toBe(400);

    const directBuild = await post(baseUrl, opsPath, { kind: 'build', directExecution: true });
    expect(directBuild.status).toBe(201);
    const { operation: build } = (await directBuild.json()) as { operation: { directExecution: boolean } };
    expect(build.directExecution).toBe(true);
  });

  it('still routes non plan/build kinds through the original create-operation path', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(runtime);
    const message = await createMessage(baseUrl, projectId, 'Explain the auth flow');

    const response = await post(
      baseUrl,
      `/projects/${projectId}/conversation/messages/${message.id}/operations`,
      { kind: 'explain', idempotencyKey: 'f'.repeat(64), artifactReferences: [] },
    );

    expect(response.status).toBe(201);
    const { operation } = (await response.json()) as { operation: { kind: string; runId?: string } };
    expect(operation.kind).toBe('explain');
    expect(operation.runId).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/conversation.test.ts --pool=threads --maxWorkers=1`
Expected: FAIL — `POST .../operations` with `{kind: 'plan'}` currently 400s (fails `CreateOperationRequestSchema`, which requires `idempotencyKey`), and `POST .../operations/:id/decide` is a 404 (route doesn't exist).

- [ ] **Step 3: Implement**

In `apps/api/src/app.ts`, add `StartOperationRequestSchema` and `DecideOperationRequestSchema` to the existing `@agent-foundry/contracts` import list, then replace the existing operations route block (currently lines 199-213) with:

```typescript
  app.post(
    '/projects/:projectId/conversation/messages/:messageId/operations',
    async (request, reply) => {
      const { projectId, messageId } = z
        .object({ projectId: PathSegmentSchema, messageId: PathSegmentSchema })
        .parse(request.params);
      const body = request.body as { kind?: unknown };
      if (body?.kind === 'plan' || body?.kind === 'build') {
        const input = StartOperationRequestSchema.parse(request.body);
        const operation = await runtime.operationService.start(projectId, messageId, input);
        return reply.status(201).send({ operation });
      }
      const input = CreateOperationRequestSchema.parse(request.body);
      const operation = await runtime.conversationService.createOperation(
        projectId,
        messageId,
        input,
      );
      return reply.status(201).send({ operation });
    },
  );

  app.post(
    '/projects/:projectId/conversation/operations/:operationId/decide',
    async (request, reply) => {
      const { projectId, operationId } = z
        .object({ projectId: PathSegmentSchema, operationId: PathSegmentSchema })
        .parse(request.params);
      const { action } = DecideOperationRequestSchema.parse(request.body);
      const operation = await runtime.operationService.decide(projectId, operationId, action);
      return reply.status(200).send({ operation });
    },
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/src/conversation.test.ts --pool=threads --maxWorkers=1`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/conversation.test.ts
git commit -m "feat(api): add start/decide operation routes for plan and build modes"
```

---

### Task 12: Web API client for conversation/operations

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Produces: `getConversation(projectId): Promise<ConversationPageResponse>`, `sendMessage(projectId, input: CreateMessageRequest): Promise<Message>`, `startOperation(projectId, messageId, input: StartOperationRequest): Promise<Operation>`, `decideOperation(projectId, operationId, action): Promise<Operation>`.

- [ ] **Step 1: There is no unit test harness for this file today** (`apps/web` has no component/unit test suite — confirmed during design research). Verification for this task is TypeScript compilation plus manual exercise in Task 13's browser check.

- [ ] **Step 2: (skipped — see Step 1)**

- [ ] **Step 3: Implement**

In `apps/web/lib/api.ts`, add to the existing `@agent-foundry/contracts` type-only import list: `ConversationPageResponse`, `CreateMessageRequest`, `Message`, `Operation`, `StartOperationRequest`. Then append these functions at the end of the file:

```typescript
export function getConversation(projectId: string): Promise<ConversationPageResponse> {
  return api<ConversationPageResponse>(`/projects/${encodeURIComponent(projectId)}/conversation`);
}

export async function sendMessage(
  projectId: string,
  input: CreateMessageRequest,
): Promise<Message> {
  const response = await api<{ message: Message }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/messages`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.message;
}

export async function startOperation(
  projectId: string,
  messageId: string,
  input: StartOperationRequest,
): Promise<Operation> {
  const response = await api<{ operation: Operation }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/messages/${encodeURIComponent(messageId)}/operations`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.operation;
}

export async function decideOperation(
  projectId: string,
  operationId: string,
  action: 'approve' | 'reject',
): Promise<Operation> {
  const response = await api<{ operation: Operation }>(
    `/projects/${encodeURIComponent(projectId)}/conversation/operations/${encodeURIComponent(operationId)}/decide`,
    { method: 'POST', body: JSON.stringify({ action }) },
  );
  return response.operation;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `npx tsc -b --force --pretty false`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "feat(web): add conversation and operation API client functions"
```

---

### Task 13: `ConversationPanel` UI

**Files:**
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**
- Consumes: `getConversation`, `sendMessage`, `startOperation`, `decideOperation` (Task 12).

- [ ] **Step 1: No automated test** — `apps/web` has no component test harness (confirmed in design research); this task is verified by manually running the dev server and exercising the flow (Step 4).

- [ ] **Step 2: (skipped — see Step 1)**

- [ ] **Step 3: Implement**

In `apps/web/app/project/[id]/page.tsx`:

1. Add to the `@agent-foundry/contracts` type-only import list: `type ConversationPageResponse`, `type Message`, `type Operation`.
2. Add to the `../../../lib/api` import list: `decideOperation`, `getConversation`, `sendMessage`, `startOperation`.
3. Inside `ProjectPage`, alongside the other `useState` declarations, add:

```typescript
  const [conversation, setConversation] = useState<ConversationPageResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');
```

4. Add a polling `useEffect`, following the file's existing active-flag + `setTimeout` pattern (place it next to the other `useEffect` blocks):

```typescript
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await getConversation(id);
        if (active) setConversation(next);
      } catch {
        // conversation panel is best-effort; the main project poll surfaces fatal errors
      }
      timer = setTimeout(poll, 2_000);
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [id]);
```

5. Add handler functions near the other handlers (e.g. next to `retry`/`submitOverride`):

```typescript
  const latestApprovedPlan = conversation?.operations
    .filter((op) => op.kind === 'plan' && op.approval?.status === 'approved')
    .at(-1);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      const message = await sendMessage(id, { role: 'user', content: [{ type: 'text', text: draft }] });
      if (mode === 'plan') {
        await startOperation(id, message.id, { kind: 'plan' });
      } else if (buildChoice === 'plan' && latestApprovedPlan) {
        await startOperation(id, message.id, { kind: 'build', planOperationId: latestApprovedPlan.id });
      } else {
        await startOperation(id, message.id, { kind: 'build', directExecution: true });
      }
      setDraft('');
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function decide(operationId: string, action: 'approve' | 'reject') {
    try {
      await decideOperation(id, operationId, action);
      setConversationError('');
      setConversation(await getConversation(id));
    } catch (cause) {
      setConversationError(cause instanceof Error ? cause.message : String(cause));
    }
  }
```

6. Insert a new section as a sibling inside the outer `<div className="shell projectShell">`, right after the `projectHero` section closes, following the file's existing `<section className="panel">` idiom:

```tsx
        <section className="panel">
          <h2>Conversa</h2>
          {conversationError ? <p className="errorBox">{conversationError}</p> : null}
          <ul className="conversationList">
            {(conversation?.messages ?? []).map((message: Message) => {
              const operation = conversation?.operations.find((op) => op.messageId === message.id);
              return (
                <li key={message.id}>
                  <strong>{message.role}:</strong>{' '}
                  {message.content.map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join(' ')}
                  {operation ? (
                    <span className="operationBadge">
                      {' '}
                      ({operation.kind}{operation.approval ? `, ${operation.approval.status}` : ''})
                      {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
                        <>
                          {' '}
                          <button className="secondaryButton" onClick={() => void decide(operation.id, 'approve')}>
                            Aprovar
                          </button>
                          <button className="secondaryButton" onClick={() => void decide(operation.id, 'reject')}>
                            Rejeitar
                          </button>
                        </>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <form onSubmit={(event) => void submitMessage(event)}>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={3} />
            <div className="modelPinGrid">
              <label>
                <input type="radio" checked={mode === 'plan'} onChange={() => setMode('plan')} /> Plan (somente
                proposta, sem alterar código)
              </label>
              <label>
                <input type="radio" checked={mode === 'build'} onChange={() => setMode('build')} /> Build (vai
                alterar código e consumir budget)
              </label>
            </div>
            {mode === 'build' ? (
              <div className="modelPinGrid">
                {latestApprovedPlan ? (
                  <label>
                    <input
                      type="radio"
                      checked={buildChoice === 'plan'}
                      onChange={() => setBuildChoice('plan')}
                    />{' '}
                    Build a partir do plano aprovado
                  </label>
                ) : null}
                <label>
                  <input
                    type="radio"
                    checked={buildChoice === 'direct' || !latestApprovedPlan}
                    onChange={() => setBuildChoice('direct')}
                  />{' '}
                  Build direto, sem plano (decisão explícita)
                </label>
                <p className="errorBox">Esta ação vai alterar o código do projeto e consumir budget.</p>
              </div>
            ) : null}
            <button className="secondaryButton" type="submit">
              Enviar
            </button>
          </form>
        </section>
```

- [ ] **Step 4: Manually verify in the running app**

Run: `npm run dev:inline` (from repo root; starts the API with `RUN_WORKER_INLINE=true` and the web app together)

In a browser at the web app's URL, open a project's page and confirm:
- The new "Conversa" section renders below the project hero.
- Typing a message and submitting with "Plan" selected creates a message + a `plan` operation badge, and no workspace/run status elsewhere on the page changes.
- Once that plan operation's badge shows `pending`, the Aprovar/Rejeitar buttons appear; clicking Aprovar flips it to `approved`.
- Selecting "Build" then "Build a partir do plano aprovado" and submitting a message creates a `build` operation.
- Selecting "Build" → "Build direto, sem plano" and submitting works without any prior plan.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/project/\[id\]/page.tsx
git commit -m "feat(web): add conversation panel with plan/build mode toggle"
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1-4: N/A** (documentation task, no test cycle)

- [ ] **Step 1: Add a short section**

Read `docs/ARCHITECTURE.md` first to match its existing heading level/style, then add a section (near wherever the conversation/orchestrator run model is already documented, or as a new subsection under the orchestrator area) covering:
- `Operation.kind` `'plan'`/`'build'` now execute via `OperationService` + `ConversationOperationRunner`, a lightweight single-`AgentStep` path parallel to the whole-project `run-project` pipeline — it never touches `Project.status`/`currentRunId`.
- Build requires an approved `plan` Operation (`POST .../operations/:id/decide`) or an explicit `directExecution: true`.
- The new `run-conversation-operation` `QueueJob` type and where it's dispatched (`WorkerLoop`).

Keep it to a few paragraphs — point at this plan's design doc (`docs/superpowers/specs/2026-07-18-plan-build-modes-design.md`) for the full rationale rather than duplicating it.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md
git commit -m "docs: document plan/build mode execution path"
```

---

## Final verification (after Task 14)

- [ ] Run the full check suite: `npm run check` (format:check, lint, architecture:check, roadmap:check, typecheck, test, build) from the repo root. Fix any failure before opening a PR.
- [ ] Confirm `git log --oneline` shows one commit per task above, each on the feature branch, none on `main`.
