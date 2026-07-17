# ADR 0019: Persist one ordered conversation per project

- Status: Accepted
- Date: 2026-07-17
- Owners: API, Orchestrator, and Persistence

## Context

Projects had durable workflow events and artifacts, but no typed conversational record joining user and agent messages, attachment metadata, and the operation requested from a message. Issue #36 requires replay and export after process restart without adding a database, upload system, classifier, or speculative execution state machine.

The runtime already uses project-scoped filesystem persistence, directory locks, Zod validation, and write-time redaction. The conversation boundary must reuse those properties and must remain readable for projects created before this aggregate existed.

## Decision

Each project has one canonical conversation whose `id` and `projectId` both equal the project id and whose `createdAt` is the project's creation time. A legacy project with no conversation files derives that value on reads and exports without writing or migrating data. The first conversation write persists it.

The aggregate is stored beneath `DATA_DIR/projects/<projectId>/conversation/`:

```text
conversation.json
messages.jsonl
attachments.jsonl
operations.jsonl
```

Messages are logically append-only. A recoverable project-conversation directory lock serializes each write, reads the complete JSONL file, and assigns the next positive contiguous `sequence`. The complete next file is synced to a temporary path and atomically renamed, so a crash leaves the live path at the previous or next complete state instead of a torn tail. Orphan temporary files are ignored during reconstruction. HTTP pages and SSE replay use the sequence as an exclusive cursor: only messages with `sequence > cursor` are returned. The conversation stream prefers the `cursor` query parameter over `Last-Event-ID`, then defaults to `0`; either cursor must be canonical nonnegative decimal text. SSE frames use the sequence as `id`, replay from the persisted JSONL store, poll once per second, and emit a heartbeat every 15 seconds.

Attachment records contain metadata only: kind, optional name, a bare MIME media type, SHA-256, byte size, and `{ scope: "project", projectId }`. A bare media type is one `type/subtype` token without parameters such as `charset`; it is normalized to lowercase. Message attachment blocks are accepted only when the referenced record belongs to the route project and its canonical conversation. This project check prevents cross-project references but is not caller authentication or multi-tenant authorization.

Operation idempotency keys are scoped to a project. Reusing a key with the same operation input, including its message and optional run/artifact links, returns the original stored operation with its original id and timestamp. Reusing the key with different input raises `IdempotencyConflictError`; the API returns HTTP `409`. Directory locking makes this comparison and append one critical section.

Message text, message data, and optional attachment names are redacted before their JSONL append. Reads, SSE, and the schema-version-1 project export therefore consume the same persisted redacted values. This is best-effort pattern/key redaction, not a guarantee that arbitrary secret shapes are detected. Operations store typed identifiers and references but no attachment bytes or provider execution output.

`GET /projects/:projectId/export` returns the project plus one coherent repository snapshot of the conversation, message, attachment, and operation records. The repository reads all four under the same writer lock. If legacy conversation storage is absent, it returns the derived empty aggregate without creating the directory; a concurrent first write is ordered wholly before or after that snapshot. `GET /projects/:projectId/conversation` pages messages while returning the aggregate's attachment and operation metadata. Full-file JSONL scans and replacements are deliberate for the local filesystem MVP; indexes or another store are added only if measured volume makes these paths hot.

## Alternatives considered

A conversation per run or browser session was rejected because issue #36 requires one durable project history. Database tables and a message broker were rejected because the existing filesystem ports and polling SSE path cover the local MVP. Reconstructing conversations from events and artifacts was rejected because those records do not contain the typed content, attachment access metadata, or idempotency input needed here.

Storing attachment blobs was rejected: issue #43 owns blob storage and the upload/chat UI. Classifying messages into operations is deferred to #38, and executing an operation through its lifecycle is deferred to #39. This ADR only persists caller-supplied typed records and their links.

## Consequences

Conversation pages, replay, and export survive API restart and preserve one deterministic order for concurrent writes. Export cannot observe an operation without the earlier message it references. Existing projects need no backfill. The lock and full-file scans/replacements assume a single shared filesystem and do not provide distributed consensus or high-volume write throughput.

Redaction is irreversible and applies only at new write time; this change does not scan or rewrite older data elsewhere in `DATA_DIR`. Attachment metadata does not prove that a blob exists or is safe. Project ownership checks reject cross-project references, but the API must remain loopback/private because it still has no caller authentication or authorization.

## Validation and rollback

Contract tests cover roles, content blocks, bare media types, canonical conversation identity, project access, requests, pages, and exports. Persistence and service tests cover concurrent contiguous sequences, stable pagination, lazy legacy derivation without directory creation, interrupted atomic replacement and orphan-temp reconstruction, coherent export snapshots against a blocked writer, cross-project rejection, idempotent same-input replay, different-input conflicts, and write-time redaction. API tests cover HTTP `409`, complete secret-safe export, query/header cursor precedence, restart-safe SSE replay, and replay beyond one 500-message batch while preserving the existing project-event stream.

Before rollback, stop processes that can write the shared `DATA_DIR` and snapshot it. The change does not rewrite project records or require a migration; an older binary leaves the additive `projects/<projectId>/conversation/` files unused. Preserve those files for a later upgrade or restore the pre-upgrade snapshot if the conversation records must be removed. Do not run old and new writers concurrently against the same directory.
