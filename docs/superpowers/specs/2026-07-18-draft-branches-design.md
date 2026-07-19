# Draft branches for emergency-ceiling failures — design

- Date: 2026-07-18
- Issue: eedsilva/agent-foundry#142 ("[v0.6] Preservar operações não aprovadas em draft branches")
- Mode: autonomous pass (no interactive user in this session — see "Process note" below)

## Process note

`superpowers:brainstorming` normally proceeds by asking the user one question at a
time. This session has no synchronous user to answer; the harness's Auto Mode
explicitly authorizes making the reasonable call and proceeding rather than
blocking. The questions that would normally be asked are answered below from
direct code reading (cited by file/line), each flagged as an **assumption**
so a reviewer can challenge it in PR review instead of in chat.

## Context (from reading the code, not from the issue text alone)

The repo has **two independent execution pipelines** that both produce a
`WorkflowRun`:

1. **`WorkflowOrchestrator.runProject`** (`packages/orchestrator/src/workflow-orchestrator.ts`) —
   drives a multi-node `WorkflowDefinition`, including `quality-loop` nodes
   (`setup` → `check` → `repair`, looping until approved). This is the only
   pipeline that tracks `execution.activeElapsedMs`, `consecutiveRepairs`, and
   an `execution.ceiling` (reason `active-time` at 4h or
   `consecutive-repairs` at 10), and the only one that calls
   `WorkspaceManager.preserveDraft`/`discardDraft`. It is reached from
   `ProjectService.create()` / `ProjectService.retry()` (the PRD-driven,
   no-chat project flow) and enqueues `QueueJob.type: 'run-project'`.
2. **`ConversationOperationRunner`** (`packages/orchestrator/src/conversation-operation-runner.ts`) —
   drives a single agent step per chat `Operation` (`plan`/`build`/…). It has
   **no** repair-loop, no `execution` accounting, and never calls
   `preserveDraft`. It is reached from `OperationService.start()` /
   `decideChangeRequest()` and enqueues `QueueJob.type: 'run-conversation-operation'`.
   `WorkerLoop.runOnce` dispatches on `job.type` — the two pipelines never
   cross.

**Assumption 1 (scope-defining):** issue #142's "repair loops" and
"emergency ceiling" refer to pipeline (1) — it is the only pipeline that has
either concept today. ADR 0021 already documents that the version-history
recording hook (issue #40) is deliberately run-level, not yet Operation-level,
for the same reason ("today's actual unit of change is a mutating workflow
step's commit, in the PRD-batch pipeline"). Building repair-loop/ceiling
tracking into `ConversationOperationRunner` from scratch would be a
much larger, separately-scoped effort (it doesn't have quality-loop nodes to
loop over) and is not attempted here.

**Assumption 2 (naming):** the issue's Portuguese text says branch
`draft/<operation-id>`. In pipeline (1) there is no `Operation` entity at all
— the unit of work is the `WorkflowRun` (`run.id`), and `WorkspaceManager.preserveDraft`
already names the branch `draft/<runId>` (`packages/persistence/src/workspace-manager.ts:149`,
using `safeSegment` to reject path/branch injection). `run.id` is the
"operation identifier" for this pipeline, so the existing naming already
satisfies the intent; no rename is planned.

## What already exists (verified by reading code + tests)

- `EmergencyCeilingError`, `RunExecutionStateSchema.ceiling` (`reason`,
  `reachedAt`, `draftBranch`) — `packages/contracts/src/run.ts`.
- Ceiling detection (time ≥ 4h, consecutive repairs ≥ 10),
  `finalizeEmergencyCeiling` (creates the draft branch, rolls the workspace
  back to `execution.lastVerifiedCheckpoint`, marks the run `failed`, emits
  `run.emergency_ceiling_reached`) — `workflow-orchestrator.ts`.
- `FileWorkspaceManager.preserveDraft`/`discardDraft`/`diff` — branch-name
  and path sanitized, race-safe (CAS on the branch's expected commit).
- 24 orchestrator tests in `emergency-ceiling.test.ts` covering both ceiling
  triggers, crash/redelivery races, and draft preservation.
- `apps/web`'s `executionEvidence()` (`apps/web/lib/model-overrides.ts`)
  already surfaces `ceiling.reason`/`reachedAt`/`draftBranch` as text in the
  project page's evidence panel.
- `getRunDetail(runId)` already returns every `StepRun`/`StepAttempt` (with
  `outputArtifacts`) for a run, already rendered unconditionally in the
  "Steps da execução" panel regardless of run status — this already satisfies
  "inspect artifacts" for a failed/ceiling run without new code.
- `ProjectService.retry(projectId)` already creates a brand new `WorkflowRun`
  and re-queues the project without touching the old run or its draft branch.
- `ProjectService.exportRunAudit`/timeline events (`ProjectEvent`, already
  streamed to the UI) are the established "durable, queryable log" pattern
  in this codebase for "who did what, when."

Net effect: most of the acceptance criteria are already implemented and
tested at the orchestrator/persistence layer. The real gap is narrow.

## What's missing (the actual scope of this change)

1. **Diff inspection for a draft.** Nothing computes/exposes the diff
   between the preserved draft and the last verified checkpoint.
2. **Retry with a new prompt or model override, without touching the draft.**
   `retry()` exists but always re-runs from the same PRD with no override
   hook wired atomically to the new run.
3. **Discard with confirmation and an audit record.** `discardDraft` exists
   in `WorkspaceManager` but is only ever called internally (cancellation
   races during finalization) — there is no user-facing endpoint, and
   nothing records who discarded a draft or when.

## Approaches considered

**A. Build a general "Draft" domain object/table.** Rejected: no other part
of this codebase has a distinct persisted "draft" entity — a draft today is
fully described by fields already on `WorkflowRun.execution.ceiling` plus a
git ref. A new entity would duplicate that and need its own repository,
migration, and sync logic for no behavior it doesn't already have.

**B. Extend the existing `WorkflowRun.execution.ceiling` shape + add three
small endpoints on the existing `ProjectService`.** (Chosen.) Reuses the
already-tested ceiling/draft machinery, the existing `ProjectEvent` stream for
audit, and the existing `getRunDetail`/evidence-panel UI for artifacts and
reason-for-stop. Only adds what's actually missing: a diff getter, a discard
mutator, and an optional prompt/override on retry.

**C. Route retry-with-override through a new `RunRetryDirective`-style
mechanism (mirroring step-level retry).** Rejected as overkill: step-level
retry directives exist because a step retry must resume mid-workflow, from a
specific step's checkpoint, possibly reusing downstream steps. A project-level
retry after ceiling has no downstream to preserve — it's a fresh
`WorkflowRun` from scratch, which `ProjectService.retry()` already builds
correctly. Reusing that method and only adding two optional fields is the
smaller, correct diff.

## Design

### contracts (`packages/contracts/src/run.ts`, `project.ts`, `api.ts`)

- `RunExecutionStateSchema.ceiling` gains three **optional** fields:
  `draftCommit` (the branch's sha at creation — `preserveDraft` already
  returns this; it was computed and discarded, never persisted), `discardedAt`,
  `discardedBy` (`ActorRefSchema`). All additive/optional — no migration for
  existing persisted runs.
- `ProjectEventSchema.type` enum gains `'run.draft_discarded'` (additive).
- New request/response schemas: `DiscardDraftRequestSchema` (`actor:
  ActorRefSchema`, `reason: string().min(1).optional()`), `RetryProjectRequestSchema`
  (`prompt: string().min(1).optional()`, `override:` same pin shape
  `CreateModelOverrideRequest` already uses, `.optional()`), `DraftDetailResponseSchema`
  (`draftBranch: string`, `diff: string`).

### persistence (`packages/persistence/src/workspace-manager.ts`)

No new methods. `diff` and `discardDraft` already accept arbitrary refs/shas;
they're reused as-is. (One test-harness fake in
`packages/orchestrator/src/testing/harness.ts` needs its `preserveDraft` fake
to keep returning `draftCommit` so the new persisted field has something to
store in tests — already returned today, just needs to flow through.)

### orchestrator

- `workflow-orchestrator.ts`: `finalizeEmergencyCeiling` persists
  `draftCommit` alongside `draftBranch` (the value already exists locally
  from `preserveDraft`'s return — one field added to an object literal).
- `ProjectService` gains:
  - `getDraft(runId)`: requires `run.execution.ceiling.draftBranch`, computes
    `workspaces.diff(projectId, lastVerifiedCheckpoint, draftBranch)`, returns
    `{ draftBranch, diff }`.
  - `discardDraft(runId, { actor, reason })`: requires an un-discarded
    `draftBranch` + `draftCommit`; calls
    `workspaces.discardDraft(projectId, runId, draftCommit)`; persists
    `ceiling.discardedAt/discardedBy(/reason kept only in the event, not
    duplicated on the run)`; appends a `run.draft_discarded` `ProjectEvent`
    (the audit record — reuses the existing durable event log and its
    existing UI timeline rendering, no new table). Idempotent: a second
    discard call on an already-discarded draft is a no-op returning the same
    run, matching the idempotency convention `cancelRun`/`pauseRun` already
    use in this file.
  - `retry(projectId, input?)`: `input.prompt`, when present, calls the
    existing `workspaces.writePrd` before creating the new run (PRD.md is the
    only per-project "prompt" this pipeline has — steps read it directly out
    of the workspace, per `prompt-compiler.ts`'s instruction to treat it as
    project data; there is no other per-run prompt field to reuse or add).
    `input.override`, when present, is validated the same way
    `createModelOverride` already validates one (catalog lookup +
    `redactOverrideAudit`) and written via the existing `ModelOverrideRepository`
    scoped to the **new** `runId` *before* the job is enqueued — this removes
    the race a caller would otherwise hit calling `createModelOverride` after
    the fact (the job could already be claimed). Neither branch ever
    references the old run's draft — retry cannot alter it by construction,
    since nothing in this path touches `discardDraft`/`preserveDraft` for the
    prior `runId`.

### API (`apps/api/src/app.ts`)

- `GET /runs/:runId/draft` → `ProjectService.getDraft`.
- `POST /runs/:runId/draft/discard` → `ProjectService.discardDraft`.
- `POST /projects/:projectId/retry` body becomes optional
  `RetryProjectRequestSchema` (back-compatible: today's callers send no body).

### apps/web

- `lib/api.ts`: `getDraft(runId)`, `discardDraft(runId, input)`; `retryProject`
  gains an optional second argument for `{ prompt, override }`.
- `project/[id]/page.tsx`: the existing evidence panel (only rendered when
  `run.execution` exists) gains, only when `evidence.draftBranch` is present
  and not discarded:
  - A "ver diff" toggle that fetches `getDraft` once and renders it with the
    same `DiffView`/`unifiedDiffToSpans` helpers the version-compare panel
    already uses (no new diff-rendering component).
  - A "Discard" button behind a native `window.confirm` (matching this
    app's existing lightweight-confirmation bar — nothing here needed a
    modal library), disabled once already discarded.
  - The existing "Tentar novamente" retry button grows an optional inline
    form (reusing `ModelPinFields`) so a user can type a replacement prompt
    and/or pin a model before retrying; leaving both blank keeps today's
    "just retry" behavior identical.

### Explicitly out of scope (per the issue)

Nothing in this design ever writes the draft branch's tree back into the
project's active history — `discard` only deletes a ref, `retry` only starts
a fresh run from the already-restored last-good checkpoint. There is no
"promote draft to active version" code path.

## Testing plan (the four required acceptance scenarios)

1. **Ceiling by time** — already covered at the unit level
   (`emergency-ceiling.test.ts`); add one assertion in that suite (or a new
   end-to-end test alongside it) that also exercises `getDraft` (diff is
   non-empty and mentions the draft's change) after the ceiling fires, to
   demonstrate the new read path against a real ceiling-by-time run.
2. **Ceiling by repair count** — same, using the existing
   10-consecutive-repairs trigger, plus `getDraft`.
3. **Retry from a draft** — new test: drive a run to ceiling, capture
   `draftBranch`'s commit sha, call `retry(projectId, { prompt, override })`,
   assert a new `runId`/`WorkflowRun` exists, the draft branch's commit sha is
   byte-identical to before, and the new run carries the override.
4. **Discard with confirmation** — new test: drive a run to ceiling, call
   `discardDraft` without an actor (rejected by schema — this is the
   "confirmation" enforcement at the API boundary; the click-through confirm
   itself is a UI concern verified manually/by description, not a unit test),
   then with an actor, assert the git branch ref is gone and a
   `run.draft_discarded` event exists carrying `discardedBy`/timestamp; call
   discard again and assert it's a no-op (idempotent, no duplicate event).

## Security/exposure notes

- Branch names are already derived from `runId` through `safeSegment`
  (rejects `..`, `/`, empty segments) before being embedded in a branch ref —
  no new user-controlled string reaches a git argument. `reason`/`actor.id`
  on discard are free text but only ever land in the event log, not in a
  shell command.
- `discardDraft`'s existing CAS (delete only if the ref still points at the
  expected commit) is preserved; the new endpoint doesn't bypass it.
