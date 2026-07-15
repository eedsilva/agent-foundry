# ADR 0012: SSE event stream over the persisted store, with append-time redaction

- Status: Accepted
- Date: 2026-07-14
- Owners: API and Web

## Context

`apps/web` tracked a running project by polling `GET /projects/:id` on a fixed interval. Polling hides latency behind the interval, and the interval can't safely shrink much further: the worker that actually emits events may run out-of-process from the API (`apps/worker` as a separate process, per `docs/ARCHITECTURE.md`), so the API has no in-memory event bus to push from — it only knows what's on disk. Any live-update mechanism has to read the same durable event log the worker writes, not a transient in-process emitter that a second API instance or a worker restart would miss.

Separately, `ProjectEvent.data` carries raw fields agents and executors produce (prompts, tool args, CLI stdout). Nothing stopped a stray API key or bearer token from an agent's output landing in a persisted event and being served back to the browser.

## Decision

Add `GET /projects/:projectId/events/stream` (`apps/api/src/app.ts`) as a standard SSE endpoint backed by the same persisted event store the polling endpoint reads (`FileEventStore` in `packages/persistence`), not a separate push channel. On connect it replays everything after the client's cursor, then tails the store on a 1-second `setInterval`, writing each new event as an SSE frame (`id: <event.id>`) and a periodic `: ping` comment to keep the connection alive through proxies.

The cursor is the event's own id: `packages/domain/src/system.ts` mints ids with `ulid()`, which sorts lexicographically with insertion order, so "give me everything after id X" is a plain string comparison (`FileEventStore.list`, `packages/persistence/src/event-store.ts`) with no separate offset or sequence table. The client can resume from `?cursor=` or from the browser-native `Last-Event-ID` header — either way `apps/web` reconnecting after a network blip or a page reload replays from exactly where it left off, and a restarted API process replays correctly too because the cursor and the data both live in the same durable file. `apps/web/app/project/[id]/page.tsx` opens the stream, merges frames into its event list by id (`apps/web/lib/events.ts`), and keeps the polling loop running underneath as the fallback — SSE only replaces polling's job of pushing new events sooner, not the whole data path.

Redaction is a pure function (`redactEvent` / `redactString`, `packages/domain/src/redaction.ts`) applied once, at the single choke point every event passes through regardless of transport: `FileEventStore.append` (`packages/persistence/src/event-store.ts`). It pattern-matches common secret shapes in string values (bearer/basic tokens, `sk-`/`rk-` and `gh*_` prefixed keys, AWS access key ids, JWT-shaped strings) and blanks values under sensitive-looking keys (`token`, `secret`, `password`, `apiKey`, `accessKey`, etc., including compound and camelCase forms). Because it runs at append time, both the polling read path and the new SSE tail read already-redacted data — there is no second redaction step to keep in sync.

## Alternatives considered

An in-process `EventEmitter` pushed from the orchestrator was rejected: it only works when worker and API share a process, and `apps/worker` is explicitly allowed to run standalone (`docs/ARCHITECTURE.md`). A message broker (Redis pub/sub, etc.) was rejected as disproportionate for a single-filesystem MVP runtime — ADR 0003 already chose files over a database for this stage. Redacting at read time (in the `/projects/:id` and `/events/stream` handlers) was rejected because it would need to run twice, in two different response-shaping code paths, with two chances to miss a field; redacting once at `append` means anything already on disk is guaranteed clean and every reader is safe by construction.

## Consequences

New events aren't visible to a connected client until the next 1-second poll tick fires, so there's a real ~1s latency floor even though this reads far sooner than the old ~1.5s polling interval and doesn't force a full project refetch. If store-tail latency ever needs to beat that floor, the fix is an in-process bus plus filesystem-change notification behind the same `EventStore` port — the ponytail comment in `app.ts` marks this spot.

Redaction is best-effort, pattern- and key-name-based; it does not understand semantics, so a secret in an unrecognized shape or under an unrecognized key can still pass through, and the executor sandbox — not this filter — remains the actual trust boundary for anything an agent can execute or exfiltrate (`docs/ARCHITECTURE.md`, "Fronteiras de confiança"). Redaction only defends the event timeline surface.

Because redaction runs at `append`, it is one-way and retroactive-proof only for events written after this change; anything already persisted before this ADR was not redacted. Extending redaction to new secret shapes only requires touching `redaction.ts` — every write path and every reader inherits the fix automatically.

## Validation and rollback

`apps/api/src/events-stream.test.ts` covers initial replay, cursor and `Last-Event-ID` resume, and restart-safe replay against a fresh store. `packages/domain/src/redaction.test.ts` and `packages/persistence/src/event-store.test.ts` cover pattern/key redaction and that `append` redacts before persisting. Rollback: remove the route and revert `apps/web` to polling only; redaction can be disabled independently by reverting `FileEventStore.append` without touching the route, since the two are decoupled behind the `EventStore` port.
