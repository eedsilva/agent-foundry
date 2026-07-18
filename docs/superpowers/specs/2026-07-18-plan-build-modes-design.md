# Plan and Build modes with distinct output contracts

Issue: [#37](https://github.com/eedsilva/agent-foundry/issues/37) (roadmap key `v06-plan-build-modes`)
Depends on: #36 `v06-conversation-domain` (merged — Conversation/Message/Attachment/Operation data model)
Blocks: `v06-chat-operations` (message→Operation classifier, context compiler — separate future issue)

## Problem

Planning and editing code are different actions with different blast radius. Today nothing in the
codebase lets a user pick "just propose a plan" vs. "actually change my project" for a single chat
turn — the only thing that creates a `WorkflowRun` is the whole-project pipeline
(`ProjectService.create`/`retry`), and the Conversation/Message/Operation model added in #36 is a
pure audit-trail layer with no execution wired to it. This issue adds that missing layer: an
explicit mode per conversation turn, gated tool/workspace policy that follows the mode into the
`TaskProfile` and compiled prompt, and a Plan → Build handoff that requires an approved plan or an
explicit override.

## Goals

- A user can send a chat message in **Plan mode** (produces an editable proposal artifact, workspace
  untouched) or **Build mode** (may write to the workspace).
- Build is blocked unless it references an **approved** Plan operation, or the caller explicitly
  chooses direct execution — and that choice is recorded for audit.
- The mode drives `TaskProfile.mutatesWorkspace` and the compiled prompt's mutation-allowed clause
  through the *existing* propagation path (model routing, executor permission flags, prompt
  compiler) — no changes to that propagation logic itself.
- Sending the identical message content in each mode produces different, observable side effects
  (required test from the roadmap spec).
- The web UI shows, before sending, whether the turn will change code and burn budget.

## Non-goals (deferred to later roadmap items)

- **Message → intent classification.** The user explicitly picks Plan or Build via a UI toggle;
  there is no auto-detection of intent from free text. That's `v06-chat-operations`.
- **Context compaction / long-conversation history compiling.** Also `v06-chat-operations`.
- **Streaming assistant responses / tool-call deltas in the UI.** `v06-chat-streaming`.
- **`explain`, `repair`, `visual-edit` Operation kinds.** The enum already has them (from #36); this
  issue only wires `plan` and `build`.
- Changing anything about the existing whole-project pipeline (`ProjectService`,
  `workflow-orchestrator.ts`'s multi-node engine, `Project.status`/`currentRunId` semantics).

## Why not reuse the existing run engine directly

`workflow-orchestrator.ts`'s `run-project` job is the only thing that executes a `WorkflowRun`
today, and it's tightly coupled to `Project` being a *single pipeline*: it mutates
`Project.status`/`currentRunId` as nodes progress. A chat-triggered Plan/Build turn is a short-lived,
single-`AgentStep` execution that can happen many times over a project's life, concurrently with (or
after) that pipeline — reusing the engine as-is would make an unrelated chat message flip a finished
project back to "running" on the dashboard.

Instead, each Plan/Build operation is exactly one `AgentStep`: no multi-node graph, no
checkpoint/quality-loop/approval-gate machinery is needed. A new, small execution path reuses the
lower-level primitives (`buildTaskProfile`, `score-router`, `compileRequestMarkdown`,
`ExecutorRegistry`, `ArtifactStore`, `StepRunRepository`/`StepAttemptRepository`) without going
through the graph engine or touching `Project` fields at all.

## Data model changes (`packages/contracts/src`)

`OperationSchema` (`conversation.ts`) gains three optional fields, all `.strict()`-compatible:

```ts
export const OperationApprovalSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']),
    decidedAt: z.string().datetime().optional(),
    decidedBy: ActorRefSchema.optional(),
  })
  .strict();

// OperationSchema additions:
approval: OperationApprovalSchema.optional(),      // only meaningful for kind === 'plan'
planOperationId: PathSegmentSchema.optional(),      // only meaningful for kind === 'build'
directExecution: z.boolean().optional(),            // kind === 'build' explicit skip-plan flag
```

- A `plan` Operation is created with `approval: { status: 'pending' }` once its run is enqueued.
- A `build` Operation must carry **exactly one** of `planOperationId` or `directExecution: true`
  (`superRefine` on `OperationSchema`, mirroring the existing `ApprovalGateStepSchema` pattern of
  cross-field validation already in `workflow.ts`).
- `directExecution: true` is the audit record of "explicit decision to execute directly."

No changes to `Message`, `Attachment`, or `Conversation`.

## New service: `OperationService`

New file `packages/orchestrator/src/operation-service.ts`, parallel to `ProjectService` — same
shape of responsibility (turn a request into a run + enqueue a job), scoped to one conversation
turn instead of a whole project. Depends on: `ConversationRepository`, `WorkflowRunRepository`,
`StepRunRepository`, `StepAttemptRepository`, `ArtifactStore`, `Queue`, `Clock`, `IdGenerator`.

```ts
class OperationService {
  async start(
    projectId: string,
    messageId: string,
    input: StartOperationRequest, // { kind: 'plan' | 'build', planOperationId?, directExecution? }
  ): Promise<Operation>

  async decide(
    projectId: string,
    operationId: string,
    action: 'approve' | 'reject',
  ): Promise<Operation>
}
```

`start()`:
1. Loads the message (404 if missing/wrong project — same checks `ConversationService.createOperation`
   already does).
2. For `kind: 'build'`: validates exactly one of `planOperationId`/`directExecution` is set. If
   `planOperationId` is set, loads that Operation and requires `kind === 'plan'` and
   `approval.status === 'approved'` (400 `ValidationError` otherwise) — and copies its
   `artifactReferences` onto the new build Operation (this *is* "Plan → Build preserves references
   to approved artifacts").
3. Builds the `AgentStep`-shaped config for the mode (see below), a `TaskProfile` via
   `buildTaskProfile` (reusing `task-profiler.ts` unchanged), and enqueues a new job type
   `run-conversation-operation` carrying `{ projectId, runId, stepConfig, taskProfile,
   operationId }`.
4. Persists the `WorkflowRun` (status `queued`) and the `Operation` (with `runId` already set,
   `artifactReferences: []` for `plan`, or copied-from-plan for `build`).

`decide()` (only for `kind: 'plan'`, run must be `completed`): reads the run's single `StepRun`'s
output artifact via `ArtifactStore`, and on `approve` sets `approval: { status: 'approved',
decidedAt, decidedBy }` and populates `artifactReferences` from that artifact. On `reject`, sets
`approval.status = 'rejected'`, no artifacts attached. Calling `decide` on an incomplete run is a
400.

## New execution path: `conversation-operation-runner.ts`

New file `packages/orchestrator/src/conversation-operation-runner.ts`, consumed by the worker for
job type `run-conversation-operation` (parallel to the existing `run-project` handler, same worker
process, new `case` in its job-type switch). For the one `AgentStep`:

1. `buildTaskProfile` → `scoreRouter` (model-router) → pick a model.
2. `compileRequestMarkdown` + `compileCliPrompt` (prompt-compiler.ts, unchanged) to build the
   request, writing `REQUEST.md` under
   `.orchestrator/runs/{runId}/steps/{stepRunId}/attempts/{attemptId}/`, matching the existing
   convention.
3. `ExecutorRegistry.get(provider).execute(...)` — same `AgentExecutionRequest` shape, so
   `mutatesWorkspace` still drives each executor's permission-mode flag exactly as it does for
   project-pipeline steps (`claude-executor.ts`, `codex-executor.ts`, `agy-executor.ts` untouched).
4. On success: `ArtifactStore.put` the resulting `AgentArtifact` (name `operation-{operationId}`),
   mark `StepRun`/`WorkflowRun` `completed`.
5. On failure (after `maxAttempts`, reusing the step's own attempt-retry policy — no cross-node
   retry needed since there's only one step): mark `WorkflowRun` `failed` with `RunError`.

Two config constants (not YAML — no `WorkflowDefinition`/`workflows/` file needed, since there's no
graph to register with a `WorkflowRepository`):

```ts
const PLAN_STEP: Omit<AgentStep, 'id' | 'instructions'> = {
  type: 'agent', role: 'planner', taskKind: 'planning',
  title: 'Chat plan proposal', outputArtifact: 'plan-proposal',
  mutatesWorkspace: false, maxAttempts: 2, inputArtifacts: [], harnessTags: [], profile: {},
};
const BUILD_STEP: Omit<AgentStep, 'id' | 'instructions'> = {
  type: 'agent', role: 'coder', taskKind: 'implementation',
  title: 'Chat build execution', outputArtifact: 'build-report',
  mutatesWorkspace: true, maxAttempts: 2, inputArtifacts: [], harnessTags: [], profile: {},
};
```

`instructions` is built per-call from the message content (and, for a plan-derived build, the
referenced plan artifact's `data`) — this is intentionally minimal string assembly, not a "context
compiler" (that's `v06-chat-operations`).

This reuses `task-profiler.ts`'s existing `DEFAULTS.planning` / `DEFAULTS.implementation` entries
unchanged — satisfying "mode and tool policy enter the TaskProfile and compiled prompt" through
code that already exists and is already tested.

## API changes (`apps/api/src/app.ts`)

- `POST /projects/:projectId/conversation/messages/:messageId/operations` — kind `plan`/`build` now
  routes to `OperationService.start()` instead of the old direct-audit
  `ConversationService.createOperation()` (that path is preserved for `explain`/`repair`/
  `visual-edit`, untouched, since nothing executes those yet).
- New: `POST /projects/:projectId/conversation/operations/:operationId/decide` — body
  `{ action: 'approve' | 'reject' }`, calls `OperationService.decide()`.

`CreateOperationRequestSchema` (`api.ts`) gains a discriminated shape for `plan`/`build` inputs
(`planOperationId`/`directExecution`), reusing the new `Operation` fields.

## Web UI (`apps/web/app/project/[id]/page.tsx`)

New inline `ConversationPanel` section, following the page's existing pattern (inline styles, direct
`lib/api.ts` calls, no new dependency):

- Message list (from `GET .../conversation`), each message showing any linked Operation's kind/status.
- Composer: textarea + a Plan/Build radio toggle (defaults to Plan).
- When Build is selected: a visible banner — "This will change your project's code and consume
  budget." — and, if there's no prior approved Plan Operation on this conversation, the send button
  requires an explicit "Build directly, skip plan" confirmation (sets `directExecution: true`); if
  there is one, it offers "Build from approved plan" (sets `planOperationId`).
- On a completed `plan` Operation: "Approve" / "Reject" buttons calling the new `decide` endpoint.
- `lib/api.ts` gains `startOperation`, `decideOperation`, `listConversation` wrappers.

## Testing

- **Contracts**: schema tests for the new `Operation` fields and the build
  `planOperationId`/`directExecution` XOR `superRefine`.
- **`OperationService`**: unit tests via the existing in-memory fakes pattern
  (`packages/orchestrator/src/testing/harness.ts`) — extended with a `MemoryConversationRepository`
  if not already sufficient, plus a fake queue/worker step for `run-conversation-operation`.
- **Required differential test** (roadmap `tests` field): send the identical message content once
  as `kind: 'plan'` and once as `kind: 'build', directExecution: true`; assert the plan run never
  calls `harness.workspaces.touch()` (mirroring the existing `if (request.mutatesWorkspace)
  this.workspaces.touch()` fake-executor check used by `workflow-orchestrator.test.ts`) while the
  build run does, and that the compiled `REQUEST.md`/`AgentExecutionRequest.mutatesWorkspace` differ
  between the two.
- **Gating tests**: build without `planOperationId`/`directExecution` → 400; build referencing a
  `pending`/`rejected` plan → 400; approve on a non-`completed` run → 400.
- **apps/api** integration test for the two new/changed routes, following existing route test
  patterns in that package.
- **apps/web**: no new automated UI test framework is introduced; manually verified in a running
  dev server (existing project convention — no component test harness exists yet in `apps/web`).

## Risks / rollback

- Purely additive: new fields are optional, new service/runner/routes are new files, existing
  `run-project` path and `ProjectService`/`Project` semantics are untouched. Rollback is reverting
  the PR; no migration of existing data is needed (new `Operation` fields are optional and absent on
  old records).
- The new `run-conversation-operation` job type must be additive to the worker's existing job-type
  switch — misrouting a `run-project` job through the new handler (or vice versa) is the main
  correctness risk; covered by a job-type-dispatch unit test.
