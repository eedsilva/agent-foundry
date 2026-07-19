# Chat streaming design (issue #39)

**Roadmap key:** `v06-chat-streaming`
**Depends on:** `v06-conversation-domain` (issue #36, merged)
**Blocks:** issue #43

## Context

The technical timeline and the conversation must meet without dumping raw stdout to the user. Today `apps/web/app/project/[id]/page.tsx` renders three separate, independently-polled/SSE'd panels: a flat conversation list, a `ProjectEvent` timeline, and a run-steps/approvals panel. Two SSE endpoints already exist and are tested (`/projects/:projectId/events/stream`, `/projects/:projectId/conversation/messages/stream`), both cursor-based via `streamSse` in `apps/api/src/app.ts`. Executors (`packages/executors/src/base-cli-executor.ts`) invoke provider CLIs that already emit line-delimited JSON on stdout (Claude: `--output-format stream-json`; Codex: `--json`), but today that stdout is only read and parsed *after* the process exits — there is no incremental/live event today.

## Goals (acceptance criteria, from the issue)

- Stream differentiates: assistant delta, status, tool start/end, approval, error.
- Reconnect recovers messages and events by cursor.
- Internal logs are collapsed by default and redacted.
- Cancel and pause appear as contextual actions.
- A completed Operation points to diff, preview, and artifacts.
- Required test: disconnect/reconnect during a tool call, verify fallback/recovery.

## Non-goals

- A new remote/sandboxed `ExecutionPlane` (issue #46) — not built yet. The `onEvent` plumbing is added at the `ExecutionPlane`/`AgentExecutor` interface level so it's ready when that lands, but only `LocalExecutionPlane` implements it now.
- Replacing the two existing SSE endpoints or their cursor mechanics — additive only.
- True token-by-token typing animation in the UI — deltas are emitted per stdout line/chunk from the CLI's own streaming granularity, not artificially split.

## Architecture

Merge happens **client-side, inside the existing "Conversa" panel** — not a wholesale replacement of `page.tsx`'s other panels. A third SSE endpoint is added, following the exact idiom the other two already use (JSONL append-only store + sequence cursor + `streamSse` helper), carrying a new normalized event type. The web client subscribes to it only while a run tied to the current conversation is active, and renders assistant deltas / tool chips / approval action / cancel-pause / completed-operation links directly under the relevant message bubble.

```
CLI subprocess stdout (stream-json / --json lines)
  -> per-provider stream-event mapper (packages/executors)
  -> onEvent callback threaded through AgentExecutor.execute() / ExecutionPlane.submit()
  -> workflow-orchestrator.ts (the only submit() caller) persists via StepEventRepository
  -> GET /runs/:runId/events/stream (new SSE endpoint, reuses streamSse)
  -> apps/web's Conversa panel subscribes per active Operation.runId
```

The existing "Linha do tempo" (`ProjectEvent`), "Steps da execução", and "Aprovações" (workflow approval-gate) panels are **left in place** as the detailed technical audit view — nothing here requires deleting them. Issue #39's "the timeline and the conversation must meet" is satisfied by the chat now surfacing live progress and the same approval/cancel/pause actions inline, not by removing the audit panels a developer may still want. Keeping them avoids re-touching a large amount of already-tested, unrelated logic (build/plan mode selection, model pinning, retry flows) that lives in the same 1386-line `page.tsx`.

## Data model

New file `packages/contracts/src/agent-stream.ts`:

```ts
// Common envelope fields are repeated on every discriminated-union member
// (each member must be a self-contained .strict() object for z.discriminatedUnion),
// same convention as MessageContentBlockSchema in conversation.ts.
const base = {
  id: PathSegmentSchema,
  runId: PathSegmentSchema,
  stepRunId: PathSegmentSchema,
  attemptId: PathSegmentSchema.optional(), // absent for approval-gate stepRuns, which have no execution attempt
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
};
AgentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('assistant_delta'), text: z.string() }).strict(),
  z.object({ ...base, type: z.literal('tool_start'), toolName: z.string(), summary: z.string() }).strict(),
  z.object({
    ...base,
    type: z.literal('tool_end'),
    toolName: z.string(),
    summary: z.string(),
    ok: z.boolean(),
    detail: z.string().max(4_000).optional(), // redacted raw excerpt shown behind "show details"
  }).strict(),
  z.object({ ...base, type: z.literal('status'), phase: z.string() }).strict(),
  z.object({ ...base, type: z.literal('approval'), approvalRequestId: PathSegmentSchema }).strict(),
  z.object({ ...base, type: z.literal('error'), message: z.string() }).strict(),
]);
```

Full raw stdout/stderr for a *successful* attempt is not persisted anywhere today (`StepAttempt` has no stdout/stderr field — only a failed attempt's `RunError` carries a truncated excerpt). Rather than adding storage for that, `tool_end` carries its own small `detail` field: a redacted, size-capped (4,000 char) excerpt of just that tool call's output, produced by the same provider mapper that classifies the line. This is the only "raw-ish" text in the whole event stream and it lives on the event itself, so "show details" is just expanding a field already in hand — no extra fetch, no new persisted blob elsewhere. `tool_start`/`tool_end` also carry a short human-readable `summary` (e.g. `"Editing src/app.ts"`) for the collapsed, default view.

## Executor changes

`packages/domain/src/ports.ts`:
```ts
AgentExecutor.execute(request, signal?, onEvent?: (event: AgentStreamEventInput) => void): Promise<AgentExecutionResult>
ExecutionPlane.submit(request, signal?, onEvent?): Promise<ExecutionResult>
```
(`AgentStreamEventInput` = the discriminated variant sans `id`/`sequence`, assigned by the repository on append — matches how `conversation-repository.ts` assigns `Message.sequence` today.)

`BaseCliExecutor.executeInvocation()`: attach a newline-splitting reader to `subprocess.stdout` as data arrives (execa exposes a real readable stream even with `reject: false`). Each complete line is handed to a new per-provider mapper:

- `packages/executors/src/claude-stream-events.ts` — parses Claude's `stream-json` line shapes (`assistant` message deltas, `tool_use` starts, `tool_result` ends, `result` as terminal/error) into the taxonomy.
- `packages/executors/src/codex-stream-events.ts` — parses Codex's `--json` JSONL (`item.completed` with `agent_message`/tool items) similarly.

Both mappers are pure functions (`line: string) => AgentStreamEventInput | undefined`), unit-testable without a subprocess, mirroring `json-output.ts`'s existing test style (`json-output.test.ts`). The existing full-stdout buffering and post-completion `parseAgentArtifact`/`extractUsage` path is untouched — the tap is additive, reading the same stream execa already buffers, not replacing it. If the provider has no incremental format (mock executor), `onEvent` is simply never called; downstream consumers must treat it as always-optional.

## Persistence

`packages/persistence/src/step-event-repository.ts` — same shape as `conversation-repository.ts`/`event-store.ts`: JSONL file per run, `withRecoverableDirectoryLock`, `append(runId, eventInput)` assigns `sequence`, `list(runId, { cursor, limit })` filters `sequence > cursor`. Rotation/pruning of old runs' event logs is out of scope for this issue (ponytail: unbounded per-run JSONL growth is the known ceiling; add TTL/archival if disk becomes a real problem — runs are finite and short-lived today).

## Wiring

`workflow-orchestrator.ts` is the sole caller of `ExecutionPlane.submit()`. It gains a small sink function passed as `onEvent` that calls `stepEventRepository.append(runId, event)`. `ApprovalRequest` creation (existing `run.approval_requested` path) additionally appends an `approval` `AgentStreamEvent` so the new stream carries approvals too, instead of the web client needing a separate approvals subscription.

## API

`apps/api/src/run.ts` (or wherever run routes live): `GET /runs/:runId/events/stream`, reusing the existing `streamSse` helper verbatim (same heartbeat + tail-poll + `Last-Event-ID` support already covered by `events-stream.test.ts`'s patterns). Cursor param name/shape matches the existing two endpoints for consistency.

## Web

The "Conversa" panel (`apps/web/app/project/[id]/page.tsx:687-770`) already renders each `Message` with its linked `Operation` badge and, for a pending plan, inline Aprovar/Rejeitar buttons — that part is reused as-is. What's missing per message with an in-flight `Operation.runId`:

- Live assistant text: subscribe to the new run-events stream only while that `Operation`'s run is non-terminal (mirrors the existing `projectTerminal`-gated `EventSource` pattern at `page.tsx:277-294`), append `assistant_delta.text` under the message.
- Tool activity: `tool_start`/`tool_end` render as a small collapsed chip (`summary`); clicking expands `tool_end.detail` if present.
- Workflow approval gates: an `approval` event with a pending `ApprovalRequest` (fetched via existing `listApprovals`) renders its actions inline, next to the message, instead of requiring a scroll to the separate "Aprovações" panel.
- Cancel: new `cancelRun` call in `apps/web/lib/api.ts` (mirrors existing `pauseRun`) and a "Cancelar" button next to the existing header "Pausar" button — reuses the already-built `POST /runs/:runId/cancel` endpoint, which the web client doesn't call anywhere yet.
- Completed Operation: once `Operation.approval?.status !== 'pending'` and the run is terminal, render links using the operation's existing `artifactReferences`/`projectVersionId` (issue #36 data) to the diff view, `PreviewPanel`, and artifact — reusing `getArtifact`/`compareVersions`/`PreviewPanel` already imported in this file, just placed in the message bubble instead of requiring a visit to the other panels.

The "Linha do tempo" / "Steps da execução" / "Aprovações" panels stay exactly as they are — this is additive to the Conversa panel, not a replacement of the others.

New file `apps/web/lib/agent-stream.ts` (alongside existing `events.ts`) holds the merge/dedup helper for the new stream, following `mergeEvents`'s exact shape (sequence-ordered, reference-stable when nothing new).

## Reconnect / cursor semantics

"Messages" reconnect-by-cursor is already satisfied today: the web client recovers the conversation by polling `getConversation` (trivially reconnect-safe) and the existing `/projects/:projectId/conversation/messages/stream` SSE endpoint is already tested for this — this issue does not need to change that. The new piece is the step-events stream: the client persists its last-seen `sequence`, and on reconnect sends it as `Last-Event-ID`/`?cursor=` so `streamSse`'s existing replay-from-cursor behavior recovers anything missed — no new protocol, the existing idiom applied to a third stream.

## Testing

- Unit: `claude-stream-events.ts`/`codex-stream-events.ts` mappers against fixture JSONL lines (mirrors `json-output.test.ts`).
- Integration: `StepEventRepository` append/list/cursor (mirrors `conversation-repository.test.ts`).
- API: new SSE endpoint reconnect test mirroring `events-stream.test.ts`'s existing "survives API restart" pattern.
- **Required test**: disconnect the SSE client while a `tool_start` has been emitted but no matching `tool_end` yet (drive a real or fixture-backed executor mid-run), reconnect, assert the client recovers the missing `tool_end` (and any subsequent deltas) via cursor replay with no duplicate `tool_start`.
- Web: Conversa panel renders live deltas/tool chips/inline approval actions for an in-flight `Operation`; collapsed tool details expand/collapse; cancel button calls the existing cancel endpoint; completed-Operation links render.

## Evidence for closure (per `docs/DEFINITION_OF_DONE.md`)

- PR linked to issue #39.
- Test output for the disconnect/reconnect-during-tool-call scenario attached.
- Screenshot or recorded flow of the unified chat timeline (assistant text, collapsed tool call, approval prompt, completed Operation linking to diff/preview/artifacts) in the running web app.
