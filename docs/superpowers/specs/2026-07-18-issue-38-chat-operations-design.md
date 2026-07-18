# Convert messages into incremental change requests and reproducible handoffs

Issue: [#38](https://github.com/eedsilva/agent-foundry/issues/38) (roadmap key `v06-chat-operations`)
Depends on: #37 `v06-plan-build-modes` (merged — `OperationService`, `ConversationOperationRunner`,
Plan→Build gating)

## Problem

`OperationService.start()` (#37) requires the caller to already know the `Operation` `kind`
(`'plan'` / `'build'`) — today that's a manual radio toggle in the web UI. Nothing in the codebase
turns a raw chat message into a classified, auditable, correctable proposal before that toggle is
used. And every compiled prompt (`conversation-step-config.ts`'s `buildConversationStep`) is built
from exactly one thing: the current message's text. There is no history, no reference to prior
decisions, and — per `docs/ARCHITECTURE.md`'s own framing of this issue — "context não pode ser uma
concatenação infinita do chat": a long-running conversation cannot just concatenate every prior
message into every future prompt.

This issue adds the missing layer between "a message arrived" and "an `Operation` is running":
classify the message into a suggested kind, let the user correct that suggestion before a `Build`
executes, and compile a bounded, reference-carrying digest of relevant history (not a raw
transcript) into the prompt — while never silently dropping a confirmed decision or an
unresolved (not-yet-confirmed) proposal from that digest.

## Goals

- A `ChangeRequest` record captures each message's classification: suggested `OperationKind`,
  a one-line rationale, which prior *confirmed* `ChangeRequest`s it references, and (after the user
  acts) the confirmed kind and the `Operation` it produced.
- The user can see and override the suggested kind before any `Build` (or any other kind) actually
  executes — `Build` is only ever created through this confirm step, never automatically from
  classification.
- A deterministic `ContextCompiler` builds a bounded digest — pinned (confirmed) decisions, still-open
  (proposed) `ChangeRequest`s, recent `ProjectVersion`s, and everything else compacted to one line —
  and every digest section still carries the source id it was built from.
- Every compiled prompt's `ChangeRequest` records exactly which messages, prior decisions, versions,
  and harness (agent-instruction) fragments fed it.
- Compaction never removes a confirmed decision or a still-proposed `ChangeRequest` from the record —
  it only reduces *how much detail* is shown for items that are neither referenced nor recent.
- Required differential test: a long conversation that changes a requirement partway through, and a
  later message that references an earlier decision in plain language, classifies and compiles
  correctly.

## Non-goals (deferred)

- **LLM-driven classification.** The classifier is pure, deterministic TypeScript (regex/keyword
  rules over message text) — no new agent step, no added latency or nondeterminism. This was an
  explicit scoping call (see "Classifier: deterministic, not LLM-driven" below); a follow-up issue
  tracks upgrading it.
- **A dedicated user-uploaded "knowledge files" store.** That's the separate, not-yet-built roadmap
  item `v06-knowledge-attachments-shell`. For this issue, "knowledge files used" is satisfied
  honestly by recording the *harness* fragments (`HarnessSelection.files` — the versioned
  agent-instruction files already selected per step) that fed the prompt; there is no other "files
  fed to the agent" concept in the codebase yet.
- **Operation execution/lifecycle changes.** `docs/ARCHITECTURE.md` already attributes that to #39.
  `ConversationOperationRunner`'s execution path (route → compile → execute → persist artifact) is
  unchanged; this issue only changes what goes *into* the compiled instructions and what gets
  recorded about the compilation.
- **Recording a `ProjectVersion` for chat-triggered builds.** `ConversationOperationRunner` doesn't
  do this today and this issue doesn't add it — out of scope, unrelated to classification/context.
- **Removing or changing the existing manual Plan/Build toggle's underlying `OperationService.start()`
  / `.decide()` methods.** Both stay exactly as #37 left them; the new classify/confirm flow is
  additive and optional (`Operation.changeRequestId` stays `undefined` for operations started the old
  way).

## Classifier: deterministic, not LLM-driven

Considered three designs: pure rule-based, a new LLM classification step, and a rules-with-LLM-fallback
hybrid. Chose pure rule-based:

- The issue's own title is "handoffs **reproduzíveis**" (reproducible handoffs) — a nondeterministic
  classification step undermines that framing directly.
- No new cost, latency, or `AgentStep`/taskKind plumbing for a step that only has to pick among 5
  known enum values from message text.
- Fully unit-testable without golden-output fuzziness.
- Weaker on genuinely ambiguous phrasing — mitigated by the required, already-planned "user can
  correct before Build" step, which is the actual safety net regardless of classifier sophistication.

A follow-up issue (opened alongside this PR, targeted at a later milestone) tracks adding an
LLM-driven or hybrid fallback once real usage data shows the rule set's failure modes.

## Data model changes (`packages/contracts/src`)

New file `change-request.ts`:

```ts
export const ChangeRequestStatusSchema = z.enum(['proposed', 'confirmed', 'rejected']);

export const ContextSourceSchema = z
  .object({
    type: z.enum(['message', 'change-request', 'project-version', 'harness-fragment']),
    id: z.string().min(1),
  })
  .strict();

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
```

`Operation.changeRequestId` already exists (added by #36, unused until now) — `OperationService.start()`
gains an optional `changeRequestId` passthrough so operations created via the new confirm flow link
back to their `ChangeRequest`. Operations created via the old direct `start()`/manual-toggle path leave
it `undefined`, unchanged.

## New pure modules (`packages/orchestrator/src`)

**`message-classifier.ts`** — `classifyMessage({ message, priorChangeRequests })` → ordered regex rules
(repair → visual-edit → explain → build → plan default) pick `suggestedKind`; a tokenize +
≥2-shared-significant-word overlap against *confirmed* prior `ChangeRequest` summaries produces
`referencedDecisionIds`. No I/O, no model calls.

**`context-compiler.ts`** — `compileContext({ message, changeRequest, allChangeRequests, versions })` →
partitions `allChangeRequests` into pinned (confirmed + referenced-or-recent), unresolved (proposed),
and compacted (everything else, one-liner only) — builds a markdown digest with one section per
partition, and a `sources: ContextSource[]` list covering every id mentioned anywhere in the digest,
including compacted ones. No I/O, no model calls.

## Service wiring (`packages/orchestrator/src`)

`OperationService` gains two methods and one constructor dependency (`ConversationService`, for the
`explain`/`repair`/`visual-edit` audit-only path it already owns):

- `classify(projectId, messageId)` — idempotent per message (returns the existing `ChangeRequest` if
  one already exists); otherwise runs `classifyMessage()` and persists a `'proposed'` `ChangeRequest`.
- `decideChangeRequest(projectId, changeRequestId, action, kind?, planOperationId?, directExecution?)` —
  `'reject'` marks `'rejected'` and stops. `'confirm'` resolves the final kind (`kind` param overrides
  `suggestedKind` — this *is* the correction), marks `'confirmed'`, and only now creates the
  `Operation`: through `this.start()` for `plan`/`build` (passing `changeRequestId` through), or through
  `conversationService.createOperation()` for the other three kinds (mirroring the existing dual-path
  dispatcher already in `apps/api/src/app.ts`).

`ConversationOperationRunner` gains one constructor dependency (`ProjectVersionRepository`, already
built earlier in `composition/runtime.ts`). In `run()`, before building the step, it loads the
operation's `ChangeRequest` (if `changeRequestId` is set) plus all of the project's `ChangeRequest`s and
its 5 most recent `ProjectVersion`s, compiles a digest, and passes it into `buildConversationStep` as a
new `## Context` section (message text stays the primary content; this is additive). After
`harness.select()` — which already runs unconditionally — it appends the selected harness fragment
paths to the digest's `sources` and persists that combined list onto the `ChangeRequest` via
`updateChangeRequest`, regardless of whether the agent execution itself later succeeds or fails (the
record is about what fed the compiled prompt, not the outcome).

Operations without a `changeRequestId` (the pre-existing manual-toggle path) skip all of the above:
`compileContext` still runs with `changeRequest: undefined` (so an old-style `Build` still benefits from
the pinned/unresolved digest), but there's no `ChangeRequest` to persist sources onto.

## API changes (`apps/api/src/app.ts`)

- `POST /projects/:projectId/conversation/messages/:messageId/classify` → `OperationService.classify()`.
- `POST /projects/:projectId/conversation/change-requests/:changeRequestId/decide` → body
  `{ action: 'reject' }` or `{ action: 'confirm', kind, planOperationId?, directExecution? }` (mirrors
  the existing `.../operations/:operationId/decide` route's naming and shape) →
  `OperationService.decideChangeRequest()`.

## Web UI (`apps/web/app/project/[id]/page.tsx`)

Message send now calls `classify()` first instead of jumping straight to `startOperation()`. The
existing Plan/Build radio (`mode` state) is pre-filled from `suggestedKind` and becomes the correction
control — its value is what gets sent as `kind` to the new decide endpoint, so it can differ from the
suggestion. A small inline card shows the rationale and any referenced decision ids (linking to the
referenced `ChangeRequest`'s summary) between send and confirm. No new test framework, per existing
project convention — manually verified in the dev server.

## Testing

- **Unit**: `message-classifier.test.ts` (including the required long-conversation +
  reference-to-old-decision fixture), `context-compiler.test.ts` (proves pinned/unresolved items are
  never dropped from `sources`, only compacted items lose detail).
- **`OperationService`**: `classify()` idempotency, `decideChangeRequest()` confirm-with-override
  (the actual correction path), reject, and the existing build-gating checks unchanged.
- **`ConversationOperationRunner`**: digest appears in compiled instructions; `contextSources` gets
  persisted including harness fragment paths; operations without `changeRequestId` are unaffected
  (regression coverage for #37's existing manual-toggle path).
- **`apps/api`**: integration test for the two new routes, plus the roadmap's required scenario
  end-to-end (classify → confirm build → later message classifies + references the earlier confirmed
  decision).

## Risks / rollback

- Purely additive: new file, new optional `Operation.changeRequestId` usage, new constructor deps with
  concrete values already available in `composition/runtime.ts`. The existing manual-toggle path
  (`OperationService.start()` called directly without a `changeRequestId`) is untouched and still
  covered by #37's existing tests.
- Rollback is reverting the PR; no data migration (new `ChangeRequest` records and the `changeRequestId`
  field are additive and absent on old records).
- Main correctness risk: the compaction partition logic accidentally drops a confirmed/proposed
  `ChangeRequest` from `sources` — covered directly by `context-compiler.test.ts` asserting set
  membership of every input id in the output `sources` list.
