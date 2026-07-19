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

Merge happens **client-side**. No new unified backend stream. A third SSE endpoint is added, following the exact idiom the other two already use (JSONL append-only store + sequence cursor + `streamSse` helper), carrying a new normalized event type. The web client subscribes to all three streams for the active project/run and renders them as one ordered timeline.

```
CLI subprocess stdout (stream-json / --json lines)
  -> per-provider stream-event mapper (packages/executors)
  -> onEvent callback threaded through AgentExecutor.execute() / ExecutionPlane.submit()
  -> workflow-orchestrator.ts (the only submit() caller) persists via StepEventRepository
  -> GET /runs/:runId/events/stream (new SSE endpoint, reuses streamSse)
  -> apps/web merges with conversation-messages stream + project-events stream
  -> one timeline component, replacing the 3 existing panels
```

## Data model

New file `packages/contracts/src/agent-stream.ts`:

```ts
AgentStreamEventSchema = z.object({
  id: PathSegmentSchema,
  runId: PathSegmentSchema,
  stepRunId: PathSegmentSchema,
  attemptId: PathSegmentSchema,
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
}).and(z.discriminatedUnion('type', [
  z.object({ type: z.literal('assistant_delta'), text: z.string() }),
  z.object({ type: z.literal('tool_start'), toolName: z.string(), summary: z.string() }),
  z.object({ type: z.literal('tool_end'), toolName: z.string(), summary: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('status'), phase: z.string() }),
  z.object({ type: z.literal('approval'), approvalRequestId: PathSegmentSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]))
```

Raw stdout/stderr are never embedded in these events (keeps the durable per-run event log small and avoids re-redacting large blobs on every line). They remain on `StepAttempt.stdout`/`.stderr` (existing field, already truncated to 20k chars and redacted at write time) for the "show details" affordance. `tool_start`/`tool_end` carry only a short human-readable `summary` string derived by the provider mapper (e.g. `"Editing src/app.ts"`), not the tool's raw arguments/output.

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

Collapse the "Conversa" / "Linha do tempo" / run-steps+approvals panels in `apps/web/app/project/[id]/page.tsx` into one ordered timeline component. Merge logic (new `apps/web/lib/agent-stream.ts`, alongside existing `events.ts`): dedupe/order by `(source stream, sequence)`, then interleave by `createdAt`. Correlate a run's live deltas to the right chat bubble via `Operation.runId` (`Message` → `Operation.messageId` link already exists). Tool events render as a single collapsed summary line by default; a "show details" toggle reveals the associated `StepAttempt.stdout`/`.stderr` (already redacted). Cancel/pause: buttons on the active-run bubble calling the existing `POST /runs/:runId/cancel` / `/pause` — no new backend endpoints.

Completed Operation rendering: use existing `Operation.artifactReferences`/`projectVersionId` to link diff, preview, and artifacts — this data already exists (issue #36), #39 only needs the chat bubble to surface it instead of requiring a separate panel visit.

## Reconnect / cursor semantics

Client persists last-seen `sequence` per stream (conversation messages, project events, new step events) exactly as the conversation stream already does. On reconnect, `Last-Event-ID` (or `?cursor=`) on all three streams replays anything missed. No new protocol — applying the existing idiom to a third stream.

## Testing

- Unit: `claude-stream-events.ts`/`codex-stream-events.ts` mappers against fixture JSONL lines (mirrors `json-output.test.ts`).
- Integration: `StepEventRepository` append/list/cursor (mirrors `conversation-repository.test.ts`).
- API: new SSE endpoint reconnect test mirroring `events-stream.test.ts`'s existing "survives API restart" pattern.
- **Required test**: disconnect the SSE client while a `tool_start` has been emitted but no matching `tool_end` yet (drive a real or fixture-backed executor mid-run), reconnect, assert the client recovers the missing `tool_end` (and any subsequent deltas) via cursor replay with no duplicate `tool_start`.
- Web: chat timeline unification renders merged/ordered events; collapsed tool details expand/collapse; cancel/pause buttons call existing endpoints.

## Evidence for closure (per `docs/DEFINITION_OF_DONE.md`)

- PR linked to issue #39.
- Test output for the disconnect/reconnect-during-tool-call scenario attached.
- Screenshot or recorded flow of the unified chat timeline (assistant text, collapsed tool call, approval prompt, completed Operation linking to diff/preview/artifacts) in the running web app.
