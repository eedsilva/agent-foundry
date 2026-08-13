# App-shape contract in the plan artifact (#478) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a validated app-shape module contract (`auth`, `dashboard`, `storage`, `crud:<resource>`, each with an acceptance channel) to the contracts package, prove it against the three HA-0.1 shapes with fixtures, and render the module list (read-only) in the operator approval UI.

**Architecture:** Add `ModuleIdSchema` / `AppShapeModuleSchema` / `AppShapeSchema` / `PlanProposalArtifactSchema` to `packages/contracts/src/plan.ts`, mirroring the existing `TaskGraphSchema`/`SchemaPlanSchema` container-loose/item-strict pattern in the same file (duplicate-id `superRefine`, `..._ARTIFACT_JSON_SCHEMA` export with `x-agent-foundry-runtime-validation` metadata). This is a pure library addition — per the issue's "Out of scope: Planner/task-graph consumption (HA-B.2)", nothing wires it into the live planner prompt, the live plan-write path, or task-graph generation; #479 (HA-B.2) does that. The approval UI (`apps/web`) fetches a pending plan's proposal (reusing the existing `getOperationProposal` API call already used by "Editar proposta"), safe-parses it with the new schema, and renders module id chips — additive, no change to approve/reject logic.

**Tech Stack:** TypeScript, Zod (`packages/contracts`), React (Next.js App Router, `apps/web`), Vitest.

## Global Constraints

- Module vocabulary is exactly: `auth`, `dashboard`, `storage`, or `crud:<resource>` (resource matches `[a-zA-Z0-9._-]+`). Reject anything else. (Issue #478 Outcome; ADR 0059 Decision.)
- Each module carries an acceptance channel. Reuse the existing `TaskAcceptanceModeSchema` enum (`'deterministic-only' | 'browser-visible'`) from `packages/contracts/src/plan.ts:6` for its value — do not invent a second enum for the same two-value concept (issue #478 agent guidance + #479's consumption needs this reuse).
- Contract evolution follows ADR 0056 precedent (forward-only versioning): container objects are `z.looseObject`, so future optional fields don't break parsing of already-persisted data; per-item objects are `z.strict()`. Mirror `packages/contracts/src/plan.ts:76-96` and `packages/contracts/src/schema-plan.ts:141-156` exactly.
- Do NOT modify `packages/orchestrator/src/conversation-operation-runner.ts`, `packages/orchestrator/src/conversation-step-config.ts`, `harness/system-prompts/planner.md`, or any planner output-schema wiring. Emitting/consuming the contract in the live planner/task-graph pipeline is HA-B.2 (#479), explicitly out of scope here.
- Approval UI change is render-only: it must not alter what "approve"/"reject" do, must not add new gating, and must not error or fail to render when a plan artifact has no `modules` (all plan artifacts today lack it — the UI must simply show nothing extra in that case).
- Run `npx tsc -b` after every task that touches `packages/contracts` or `apps/web`.
- New test files land in the existing fast Vitest bucket automatically (neither `packages/contracts/**` nor `apps/web/**` is excluded from `test:unit:fast` in `package.json`) — do not edit the fast/slow partition lists.

---

### Task 1: App-shape contract schema in the contracts package

**Files:**
- Modify: `packages/contracts/src/plan.ts` (append after the existing `TASK_GRAPH_ARTIFACT_JSON_SCHEMA` export at the end of the file)
- Modify: `packages/contracts/src/plan.test.ts` (append a new `describe` block; add three names to the existing `import { ... } from './plan.js'` block)
- Modify: `docs/adr/0059-app-shape-contract-in-plan-artifact.md:3` (flip `- Status: Proposed` to `- Status: Accepted`, matching how ADR 0056/0058/0060 read once implemented)

**Interfaces:**
- Consumes: `TaskAcceptanceModeSchema` (already exported from `plan.ts:6`), `AgentArtifactSchema` (already imported into `plan.ts` from `./agent.js`).
- Produces (for Tasks 2 and 3): `ModuleIdSchema`, `AppShapeModuleSchema` (fields: `id: ModuleId`, `acceptanceChannel: TaskAcceptanceMode`), `AppShapeSchema` (fields: `schemaVersion: '1'`, `modules: AppShapeModule[]`, min 1 max 50, duplicate ids rejected), `AppShape` type, `PlanProposalArtifactSchema` (= `AgentArtifactSchema.extend({ data: AppShapeSchema })`), `PlanProposalArtifact` type, `PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA` constant.

- [ ] **Step 1: Write the failing tests**

Open `packages/contracts/src/plan.test.ts`. Change the top import block from:

```ts
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  TaskGraphArtifactSchema,
  TaskGraphSchema,
} from './plan.js';
```

to:

```ts
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
  TaskGraphArtifactSchema,
  TaskGraphSchema,
  PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA,
  AppShapeSchema,
  PlanProposalArtifactSchema,
} from './plan.js';
```

Then append this block at the end of the file (after the closing `});` of the `'task graph contracts'` describe block):

```ts

describe('app-shape contract (#478)', () => {
  const shape = {
    schemaVersion: '1' as const,
    modules: [
      { id: 'auth', acceptanceChannel: 'browser-visible' as const },
      { id: 'crud:items', acceptanceChannel: 'browser-visible' as const },
    ],
  };

  it('exports the app-shape schemas', () => {
    expect('AppShapeSchema' in contracts).toBe(true);
    expect('PlanProposalArtifactSchema' in contracts).toBe(true);
    expect('PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA' in contracts).toBe(true);
  });

  it('accepts the fixed module ids and crud:<resource> variants', () => {
    expect(AppShapeSchema.parse(shape).modules.map((module) => module.id)).toEqual([
      'auth',
      'crud:items',
    ]);
    expect(
      AppShapeSchema.parse({
        ...shape,
        modules: [
          { id: 'dashboard', acceptanceChannel: 'deterministic-only' },
          { id: 'storage', acceptanceChannel: 'deterministic-only' },
        ],
      }).modules.map((module) => module.id),
    ).toEqual(['dashboard', 'storage']);
  });

  it('rejects an unknown module id', () => {
    expect(() =>
      AppShapeSchema.parse({
        ...shape,
        modules: [{ id: 'billing', acceptanceChannel: 'deterministic-only' }],
      }),
    ).toThrow(/Module must be one of/);
  });

  it('rejects a malformed crud module id', () => {
    expect(() =>
      AppShapeSchema.parse({
        ...shape,
        modules: [{ id: 'crud:', acceptanceChannel: 'deterministic-only' }],
      }),
    ).toThrow(/Module must be one of/);
  });

  it('rejects a duplicate module id', () => {
    expect(() =>
      AppShapeSchema.parse({
        ...shape,
        modules: [shape.modules[0], shape.modules[0]],
      }),
    ).toThrow(/Duplicate module id auth/);
  });

  it('requires an acceptance channel per module', () => {
    expect(() =>
      AppShapeSchema.parse({
        ...shape,
        modules: [{ id: 'auth' }],
      }),
    ).toThrow();
  });

  it('caps the module list at 50 and requires at least one module', () => {
    expect(() => AppShapeSchema.parse({ schemaVersion: '1', modules: [] })).toThrow();
    const modules = Array.from({ length: 51 }, (_, index) => ({
      id: `crud:resource-${index}`,
      acceptanceChannel: 'deterministic-only' as const,
    }));
    expect(() => AppShapeSchema.parse({ schemaVersion: '1', modules })).toThrow();
  });

  it('wraps the app shape in the agent artifact envelope', () => {
    expect(
      PlanProposalArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the module list',
        data: shape,
      }).data.modules,
    ).toHaveLength(2);
    expect(() =>
      PlanProposalArtifactSchema.parse({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the module list',
        data: { note: 'prose instead of modules' },
      }),
    ).toThrow();
  });

  it('publishes a model-facing JSON schema with the runtime validation marker', () => {
    expect(PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA.$id).toMatch(/plan-proposal-artifact-v1/);
    expect(
      PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA['x-agent-foundry-runtime-validation'],
    ).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/contracts/src/plan.test.ts`
Expected: FAIL — `AppShapeSchema`, `PlanProposalArtifactSchema`, `PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA` are not exported from `./plan.js`.

- [ ] **Step 3: Implement the schema**

Append this block to the end of `packages/contracts/src/plan.ts` (after the existing `TASK_GRAPH_ARTIFACT_JSON_SCHEMA` export):

```ts

const APP_SHAPE_FIXED_MODULE_IDS = ['auth', 'dashboard', 'storage'] as const;
const APP_SHAPE_CRUD_MODULE_ID_PATTERN = /^crud:[a-zA-Z0-9._-]+$/;

/** Module vocabulary from #473's observed-shape defect list: auth, dashboard,
 * storage, or a crud:<resource> variant. Unknown ids are rejected. */
export const ModuleIdSchema = z
  .string()
  .refine(
    (value) =>
      (APP_SHAPE_FIXED_MODULE_IDS as readonly string[]).includes(value) ||
      APP_SHAPE_CRUD_MODULE_ID_PATTERN.test(value),
    {
      message: `Module must be one of ${APP_SHAPE_FIXED_MODULE_IDS.join(', ')}, or crud:<resource>`,
    },
  );
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const AppShapeModuleSchema = z
  .object({
    id: ModuleIdSchema,
    acceptanceChannel: TaskAcceptanceModeSchema,
  })
  .strict();
export type AppShapeModule = z.infer<typeof AppShapeModuleSchema>;

type AppShapeModuleForValidation = { id: string };

function validateAppShapeModules(
  modules: readonly AppShapeModuleForValidation[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, module] of modules.entries()) {
    if (seen.has(module.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['modules', index, 'id'],
        message: `Duplicate module id ${module.id}`,
      });
    }
    seen.add(module.id);
  }
}

// Loose: forward-only versioning per ADR 0056 — future optional fields on the
// app-shape contract must not break parsing of already-persisted plan artifacts.
export const AppShapeSchema = z
  .looseObject({
    schemaVersion: z.literal('1'),
    modules: z.array(AppShapeModuleSchema).min(1).max(50),
  })
  .superRefine((shape, ctx) => {
    validateAppShapeModules(shape.modules as AppShapeModuleForValidation[], ctx);
  });
export type AppShape = z.infer<typeof AppShapeSchema>;

export const PlanProposalArtifactSchema = AgentArtifactSchema.extend({
  data: AppShapeSchema,
});
export type PlanProposalArtifact = z.infer<typeof PlanProposalArtifactSchema>;

export const PLAN_PROPOSAL_ARTIFACT_JSON_SCHEMA = {
  $id: 'https://agent-foundry.dev/schemas/plan-proposal-artifact-v1.json',
  ...z.toJSONSchema(PlanProposalArtifactSchema),
  'x-agent-foundry-runtime-validation': {
    moduleVocabulary: {
      path: 'data.modules[*].id',
      enforcedBy: 'PlanProposalArtifactSchema',
      description:
        'Standard JSON Schema cannot express the crud:<resource> templated variant or cross-item uniqueness; the runtime Zod parse rejects module ids outside auth, dashboard, storage, crud:<resource>, and duplicate module ids within one plan.',
    },
  },
};
```

Then open `docs/adr/0059-app-shape-contract-in-plan-artifact.md` and change line 3 from `- Status: Proposed` to `- Status: Accepted`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/contracts/src/plan.test.ts`
Expected: PASS, all tests including the new `app-shape contract (#478)` block.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/plan.ts packages/contracts/src/plan.test.ts docs/adr/0059-app-shape-contract-in-plan-artifact.md
git commit -m "feat(478): add app-shape module contract to the plan artifact"
```

---

### Task 2: HA-0.1 fixtures for the three shapes

**Files:**
- Create: `docs/evidence/harness-alignment/crud-heavy/app-shape.json`
- Create: `docs/evidence/harness-alignment/dashboard-heavy/app-shape.json`
- Create: `docs/evidence/harness-alignment/auth-heavy/app-shape.json`
- Create: `packages/contracts/src/app-shape-fixtures.test.ts`

**Interfaces:**
- Consumes: `AppShapeSchema` from `./plan.js` (produced by Task 1).
- Produces: nothing consumed by later tasks — this task is self-contained evidence + test.

This task depends on Task 1 (needs `AppShapeSchema` to exist and be exported). Do not start it before Task 1 is complete.

- [ ] **Step 1: Write the failing test**

Create `packages/contracts/src/app-shape-fixtures.test.ts` with this exact content (mirrors the existing `packages/contracts/src/schema-plan-fixtures.test.ts` pattern for the same three shapes):

```ts
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppShapeSchema } from './plan.js';

async function readFixture(shape: string) {
  const path = resolve(
    import.meta.dirname,
    `../../../docs/evidence/harness-alignment/${shape}/app-shape.json`,
  );
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('HA-0.1 app-shape fixtures (#478)', () => {
  it('validates the crud-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('crud-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual([
      'auth',
      'crud:categories',
      'crud:items',
      'crud:stock-adjustments',
    ]);
  });

  it('validates the dashboard-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('dashboard-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual([
      'auth',
      'dashboard',
      'crud:sale-events',
    ]);
  });

  it('validates the auth-heavy shape module list', async () => {
    const shape = AppShapeSchema.parse(await readFixture('auth-heavy'));
    expect(shape.modules.map((module) => module.id)).toEqual(['auth', 'crud:profiles']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/app-shape-fixtures.test.ts`
Expected: FAIL — `ENOENT` reading `docs/evidence/harness-alignment/crud-heavy/app-shape.json` (file does not exist yet).

- [ ] **Step 3: Write the fixtures**

Create `docs/evidence/harness-alignment/crud-heavy/app-shape.json` (module list for the Inventory Tracker PRD at `docs/evidence/harness-alignment/crud-heavy/prd.md`: sign-in-gated app with categories, items, and a stock-adjustment log, all reachable in the browser):

```json
{
  "schemaVersion": "1",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "crud:categories", "acceptanceChannel": "browser-visible" },
    { "id": "crud:items", "acceptanceChannel": "browser-visible" },
    { "id": "crud:stock-adjustments", "acceptanceChannel": "browser-visible" }
  ]
}
```

Create `docs/evidence/harness-alignment/dashboard-heavy/app-shape.json` (module list for the Sales Metrics Viewer PRD at `docs/evidence/harness-alignment/dashboard-heavy/prd.md`: sign-in-gated dashboard with charts plus manual sale-event entry):

```json
{
  "schemaVersion": "1",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "dashboard", "acceptanceChannel": "browser-visible" },
    { "id": "crud:sale-events", "acceptanceChannel": "browser-visible" }
  ]
}
```

Create `docs/evidence/harness-alignment/auth-heavy/app-shape.json` (module list for the Members Area PRD at `docs/evidence/harness-alignment/auth-heavy/prd.md`: role-gated auth plus a profiles/member-directory resource):

```json
{
  "schemaVersion": "1",
  "modules": [
    { "id": "auth", "acceptanceChannel": "browser-visible" },
    { "id": "crud:profiles", "acceptanceChannel": "browser-visible" }
  ]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/app-shape-fixtures.test.ts`
Expected: PASS, 3/3.

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add docs/evidence/harness-alignment/crud-heavy/app-shape.json docs/evidence/harness-alignment/dashboard-heavy/app-shape.json docs/evidence/harness-alignment/auth-heavy/app-shape.json packages/contracts/src/app-shape-fixtures.test.ts
git commit -m "test(478): add HA-0.1 app-shape fixtures for the three shapes"
```

---

### Task 3: Render the module list in the operator approval UI

**Files:**
- Modify: `apps/web/app/project/[id]/conversation-list.tsx`
- Modify: `apps/web/app/project/[id]/chat-pane.tsx`
- Create: `apps/web/app/project/[id]/conversation-list.test.tsx`

**Interfaces:**
- Consumes: `AppShapeModule` type and `PlanProposalArtifactSchema` value from `@agent-foundry/contracts` (produced by Task 1); `getOperationProposal(projectId, operationId): Promise<StoredArtifact>` (already exists at `apps/web/lib/api.ts:424`).
- Produces: `ConversationList`'s new `pendingPlanModules` prop (type `{ operationId: string; modules: AppShapeModule[] } | null`) — nothing later depends on this; it's the final task.

This task depends on Task 1 (needs `AppShapeModule`/`PlanProposalArtifactSchema` exported from `@agent-foundry/contracts`, which requires `npm run build` or the workspace TS project reference to pick up the new exports — running `npx tsc -b` from the repo root, per Global Constraints, covers this).

- [ ] **Step 1: Write the failing test**

Create `apps/web/app/project/[id]/conversation-list.test.tsx` with this exact content (mirrors the `renderToStaticMarkup` + factory-function pattern in `apps/web/app/project/[id]/run-alert-strip.test.tsx`):

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type {
  AppShapeModule,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';
import { ConversationList } from './conversation-list';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    role: 'user',
    content: [{ type: 'text', text: 'Build me an inventory tracker' }],
    sequence: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'operation-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    kind: 'plan',
    idempotencyKey: 'idem-1',
    artifactReferences: [{ name: 'plan-proposal', revision: 1, sha256: 'a'.repeat(64) }],
    contextSources: [],
    approval: { status: 'pending' },
    createdAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function makeConversation(operations: Operation[], messages: Message[]): ConversationPageResponse {
  return {
    conversation: { id: 'project-1', projectId: 'project-1', createdAt: '2026-08-12T00:00:00.000Z' },
    messages,
    attachments: [],
    operations,
    nextCursor: null,
  };
}

const noop = () => undefined;

function renderList(overrides: Partial<Parameters<typeof ConversationList>[0]> = {}): string {
  return renderToStaticMarkup(
    <ConversationList
      projectId="project-1"
      conversation={makeConversation([makeOperation()], [makeMessage()])}
      activeOperation={undefined}
      latestOperation={undefined}
      latestOperationRunTerminal
      streamEvents={[]}
      proposalEditor={null}
      setProposalEditor={noop}
      onEditProposal={noop}
      onSaveProposal={noop}
      onDecide={noop}
      onCancelRun={noop}
      onOpenArtifactRef={noop}
      pendingPlanModules={null}
      {...overrides}
    />,
  );
}

describe('ConversationList module list', () => {
  it('renders module chips for the pending plan operation that fetched them', () => {
    const modules: AppShapeModule[] = [
      { id: 'auth', acceptanceChannel: 'browser-visible' },
      { id: 'crud:items', acceptanceChannel: 'browser-visible' },
    ];
    const markup = renderList({
      pendingPlanModules: { operationId: 'operation-1', modules },
    });
    expect(markup).toContain('auth');
    expect(markup).toContain('crud:items');
  });

  it('renders nothing extra when no modules have been fetched yet', () => {
    const markup = renderList({ pendingPlanModules: null });
    expect(markup).not.toContain('crud:items');
  });

  it('does not render modules fetched for a different operation', () => {
    const markup = renderList({
      pendingPlanModules: {
        operationId: 'some-other-operation',
        modules: [{ id: 'auth', acceptanceChannel: 'browser-visible' }],
      },
    });
    expect(markup).not.toContain('auth');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/web/app/project/\[id\]/conversation-list.test.tsx`
Expected: FAIL — TypeScript error, `pendingPlanModules` does not exist on `ConversationList`'s props.

- [ ] **Step 3: Implement the render-only module list**

In `apps/web/app/project/[id]/conversation-list.tsx`, change the import block at the top from:

```tsx
import React from 'react';
import type {
  AgentStreamEvent,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { BTN, CHIP, ERROR_BOX, MONO_PANE, TEXTAREA } from '@/lib/ui';
```

to:

```tsx
import React from 'react';
import type {
  AgentStreamEvent,
  AppShapeModule,
  ConversationPageResponse,
  Message,
  Operation,
} from '@agent-foundry/contracts';
import { EmptyState } from '@/components/empty-state';
import { BTN, CHIP, ERROR_BOX, MONO_PANE, TEXTAREA } from '@/lib/ui';
```

Change the `ConversationList` function signature from:

```tsx
export function ConversationList({
  projectId,
  conversation,
  activeOperation,
  latestOperation,
  latestOperationRunTerminal,
  streamEvents,
  proposalEditor,
  setProposalEditor,
  onEditProposal,
  onSaveProposal,
  onDecide,
  onCancelRun,
  onOpenArtifactRef,
}: {
  projectId: string;
  conversation: ConversationPageResponse | null;
  activeOperation: Operation | undefined;
  latestOperation: Operation | undefined;
  latestOperationRunTerminal: boolean;
  streamEvents: AgentStreamEvent[];
  proposalEditor: ProposalEditorState | null;
  setProposalEditor: (editor: ProposalEditorState | null) => void;
  onEditProposal: (operationId: string) => void;
  onSaveProposal: () => void;
  onDecide: (operationId: string, action: 'approve' | 'reject') => void;
  onCancelRun: (runId: string) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
}) {
```

to:

```tsx
export function ConversationList({
  projectId,
  conversation,
  activeOperation,
  latestOperation,
  latestOperationRunTerminal,
  streamEvents,
  proposalEditor,
  setProposalEditor,
  onEditProposal,
  onSaveProposal,
  onDecide,
  onCancelRun,
  onOpenArtifactRef,
  pendingPlanModules,
}: {
  projectId: string;
  conversation: ConversationPageResponse | null;
  activeOperation: Operation | undefined;
  latestOperation: Operation | undefined;
  latestOperationRunTerminal: boolean;
  streamEvents: AgentStreamEvent[];
  proposalEditor: ProposalEditorState | null;
  setProposalEditor: (editor: ProposalEditorState | null) => void;
  onEditProposal: (operationId: string) => void;
  onSaveProposal: () => void;
  onDecide: (operationId: string, action: 'approve' | 'reject') => void;
  onCancelRun: (runId: string) => void;
  onOpenArtifactRef: (name: string, revision: number) => void;
  pendingPlanModules: { operationId: string; modules: AppShapeModule[] } | null;
}) {
```

Then, inside the `{operation ? (...)}` block, right after the closing `</span>` of the chip (`{operation.approval ? ...}` span) and before the `{operation.kind === 'plan' && operation.approval?.status === 'pending' ? (` approve/reject block, insert a new conditional. The chip block currently reads:

```tsx
                <span className={CHIP}>
                  {operation.kind}
                  {operation.approval ? `, ${operation.approval.status}` : ''}
                </span>
                {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
```

Change it to:

```tsx
                <span className={CHIP}>
                  {operation.kind}
                  {operation.approval ? `, ${operation.approval.status}` : ''}
                </span>
                {operation.kind === 'plan' &&
                pendingPlanModules?.operationId === operation.id &&
                pendingPlanModules.modules.length > 0 ? (
                  <span aria-label="Módulos do plano" className="mt-2 flex flex-wrap gap-1">
                    {pendingPlanModules.modules.map((module) => (
                      <span key={module.id} className={CHIP}>
                        {module.id}
                      </span>
                    ))}
                  </span>
                ) : null}
                {operation.kind === 'plan' && operation.approval?.status === 'pending' ? (
```

Now open `apps/web/app/project/[id]/chat-pane.tsx`. Change the import block at the top from:

```tsx
import React, { useEffect, useState, type FormEvent } from 'react';
import type {
  AgentArtifact,
  AgentStreamEvent,
  ChangeRequest,
  ConversationPageResponse,
  KnowledgeFile,
  Operation,
  OperationKind,
} from '@agent-foundry/contracts';
import {
  classifyMessage,
  decideChangeRequest,
  decideOperation,
  getConversation,
  getOperationProposal,
  sendMessage,
  startOperation,
  updateOperationProposal,
} from '../../../lib/api';
```

to:

```tsx
import React, { useEffect, useState, type FormEvent } from 'react';
import type {
  AgentArtifact,
  AgentStreamEvent,
  AppShapeModule,
  ChangeRequest,
  ConversationPageResponse,
  KnowledgeFile,
  Operation,
  OperationKind,
} from '@agent-foundry/contracts';
import { PlanProposalArtifactSchema } from '@agent-foundry/contracts';
import {
  classifyMessage,
  decideChangeRequest,
  decideOperation,
  getConversation,
  getOperationProposal,
  sendMessage,
  startOperation,
  updateOperationProposal,
} from '../../../lib/api';
```

Change the state declarations block from:

```tsx
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');
  const [pendingChangeRequest, setPendingChangeRequest] = useState<ChangeRequest | null>(null);
  const [proposalEditor, setProposalEditor] = useState<ProposalEditorState | null>(null);
  const [repairingPreview, setRepairingPreview] = useState(false);
```

to:

```tsx
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'plan' | 'build'>('plan');
  const [buildChoice, setBuildChoice] = useState<'plan' | 'direct'>('plan');
  const [conversationError, setConversationError] = useState('');
  const [pendingChangeRequest, setPendingChangeRequest] = useState<ChangeRequest | null>(null);
  const [proposalEditor, setProposalEditor] = useState<ProposalEditorState | null>(null);
  const [repairingPreview, setRepairingPreview] = useState(false);
  const [planModules, setPlanModules] = useState<{
    operationId: string;
    modules: AppShapeModule[];
  } | null>(null);

  const pendingPlanOperation = conversation?.operations.find(
    (operation) =>
      operation.kind === 'plan' &&
      operation.approval?.status === 'pending' &&
      operation.artifactReferences.length > 0,
  );
  const pendingPlanOperationId = pendingPlanOperation?.id;
  const pendingPlanRevision = pendingPlanOperation?.artifactReferences[0]?.revision;

  // Renders the module list next to the approve/reject buttons — render-only,
  // does not affect approval semantics. Old plan artifacts have no `modules`
  // field; safeParse leaves `planModules` at an empty list for those.
  useEffect(() => {
    if (!pendingPlanOperationId) {
      setPlanModules(null);
      return;
    }
    let cancelled = false;
    void getOperationProposal(id, pendingPlanOperationId).then((artifact) => {
      if (cancelled) return;
      const parsed = PlanProposalArtifactSchema.safeParse(artifact.content);
      setPlanModules({
        operationId: pendingPlanOperationId,
        modules: parsed.success ? parsed.data.data.modules : [],
      });
    });
    return () => {
      cancelled = true;
    };
  }, [id, pendingPlanOperationId, pendingPlanRevision]);
```

Finally, in the `<ConversationList ... />` render call, add the new prop:

```tsx
        <ConversationList
          projectId={projectId}
          conversation={conversation}
          activeOperation={activeOperation}
          latestOperation={latestOperation}
          latestOperationRunTerminal={latestOperationRunTerminal}
          streamEvents={streamEvents}
          proposalEditor={proposalEditor}
          setProposalEditor={setProposalEditor}
          onEditProposal={(operationId) => void editProposal(operationId)}
          onSaveProposal={() => void saveProposal()}
          onDecide={(operationId, action) => void decide(operationId, action)}
          onCancelRun={onCancelRun}
          onOpenArtifactRef={onOpenArtifactRef}
          pendingPlanModules={planModules}
        />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/app/project/\[id\]/conversation-list.test.tsx apps/web/app/project/\[id\]/chat-pane.test.tsx`
Expected: PASS, all tests (3 new + the existing preview-repair test).

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/project/\[id\]/conversation-list.tsx apps/web/app/project/\[id\]/chat-pane.tsx apps/web/app/project/\[id\]/conversation-list.test.tsx
git commit -m "feat(478): render the plan's module list in the approval UI"
```

---

## Final Verification

After all three tasks:

- [ ] Run `npx tsc -b` from the repo root — no errors.
- [ ] Run `npm run test:unit:fast` — all tests pass, including the three new test files.
- [ ] Confirm no changes landed outside `packages/contracts/src/plan.ts`, `packages/contracts/src/plan.test.ts`, `packages/contracts/src/app-shape-fixtures.test.ts`, `docs/evidence/harness-alignment/*/app-shape.json`, `docs/adr/0059-app-shape-contract-in-plan-artifact.md`, `apps/web/app/project/[id]/conversation-list.tsx`, `apps/web/app/project/[id]/chat-pane.tsx`, `apps/web/app/project/[id]/conversation-list.test.tsx` (`git diff --stat main...HEAD`).
