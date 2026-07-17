# Final Whole-Branch Review Fix Report

## Status

Complete.

Implementation commit: `0a363fb505c58017a2d9fcfb84027413bc44596c` (`fix(conversation): make persistence crash-consistent`)

## RED evidence

Tests were added before production changes.

Command:

```bash
npm run test:unit -- packages/contracts/src/conversation.test.ts packages/persistence/src/conversation-repository.test.ts
```

Result: exit 1; 2 files failed, 4 tests failed, and 11 tests passed.

- `ConversationSchema` accepted `id: conversation-1` with `projectId: project-1`.
- Reconstruction resolved a malformed `conversation.json` with mismatched identity instead of rejecting it.
- The repository ignored the injected interrupted-replacement writer and appended the second message successfully.
- `FileConversationRepository.getSnapshot` did not exist.

Service command:

```bash
npm run test:unit -- packages/orchestrator/src/conversation-service.test.ts
```

Result: exit 1; 1 file failed, 1 test failed, and 3 tests passed. Export performed zero repository snapshot reads instead of exactly one.

## GREEN evidence

Focused contracts, persistence, and orchestrator command:

```bash
npm run test:unit -- packages/contracts/src/conversation.test.ts packages/contracts/src/api.test.ts packages/persistence/src/conversation-repository.test.ts packages/orchestrator/src/conversation-service.test.ts
```

Result: exit 0; 4 files passed and 33 tests passed.

Focused API command:

```bash
LOG_LEVEL=silent npx vitest run apps/api/src/conversation.test.ts apps/api/src/events-stream.test.ts --pool=threads --maxWorkers=1 --reporter=verbose
```

Result: exit 0; 2 files passed and 12 tests passed.

Composition command:

```bash
LOG_LEVEL=silent npm run test:unit -- packages/composition/src/runtime.integration.test.ts
```

Result: exit 0; 1 file passed and 5 tests passed.

Additional targeted checks all exited 0:

```bash
npm run typecheck
npm run build
npx eslint packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts packages/contracts/src/api.test.ts packages/domain/src/ports.ts packages/persistence/src/conversation-repository.ts packages/persistence/src/conversation-repository.test.ts packages/orchestrator/src/conversation-service.ts packages/orchestrator/src/conversation-service.test.ts --max-warnings=0
npx prettier --check packages/contracts/src/conversation.ts packages/contracts/src/conversation.test.ts packages/contracts/src/api.test.ts packages/domain/src/ports.ts packages/persistence/src/conversation-repository.ts packages/persistence/src/conversation-repository.test.ts packages/orchestrator/src/conversation-service.ts packages/orchestrator/src/conversation-service.test.ts docs/adr/0019-conversation-domain.md docs/ARCHITECTURE.md docs/OPERATIONS.md docs/SECURITY.md docs/VALIDATION.md
git diff --check
```

Final repository gate:

```bash
npm run check
```

Result: exit 0.

- Prettier and ESLint passed.
- Architecture passed for 11 workspaces plus 2 architecture tests.
- Roadmap validation passed for 16 milestones, 114 tasks, and 131 managed issues plus 8 roadmap/governance tests.
- TypeScript passed.
- Vitest passed 64 files / 599 tests.
- Node script tests passed 42 / 42.
- All eight packages, API, worker, and the Next.js web application built successfully.

Environment gate:

```bash
npm run doctor
```

Result: exit 0 in mock mode; Node, Git, harness, workflows, model catalog, Codex, Claude, and AGY were ready.

## Design

- The shared `ConversationSchema` now owns the canonical `id === projectId` invariant. The repository's duplicate create-only guard was deleted, so direct contracts and disk reconstruction use the same boundary.
- Conversation JSONL records remain logically append-only. Under the existing recoverable conversation lock, each write reuses the already-required full scan and publishes the complete next file through the existing synced temp-file plus atomic-rename helper. A failed pre-rename publication leaves the previous live file intact; orphan temp files are outside the exact live paths read during reconstruction.
- `ConversationRepository.getSnapshot` returns conversation, messages, attachments, and operations under the same lock used by writers. `ConversationService.export` consumes only that snapshot.
- The absent-directory fast path returns an empty legacy snapshot without creating storage. If a first writer races that check, the snapshot linearizes before the directory appears or acquires the shared lock and linearizes wholly before or after the write.
- The existing Ponytail full-file scan ceiling remains explicit. No dependency, retry loop, index, migration, or service-level reconciliation was added.

## Self-review

- Confirmed all three JSONL write paths use atomic complete-file replacement; the event store's unrelated append path was not changed.
- Confirmed malformed persisted canonical identity is rejected by the same schema used at every boundary.
- Confirmed the deterministic interruption test leaves the first message reconstructable, observes the orphan temp file, and then appends sequence 2 successfully after restart.
- Confirmed the deterministic concurrency test blocks an operation write while it owns the repository lock, starts the snapshot, releases the write, and proves the captured operation's message is present. It uses no polling, sleeps, or large payload.
- Confirmed legacy export/snapshot reads leave `projects/<id>/conversation/` absent.
- Confirmed service export performs exactly one repository snapshot read and no independent aggregate list reads.
- Confirmed docs describe physical replacement cost, crash behavior, coherent export, and the unchanged no-read-time-migration contract.
- Confirmed `.superpowers/sdd/progress.md` was not edited, and nothing was pushed or published.

## Concerns

Full-file scan plus replacement is intentionally O(n) per write and remains suitable only for the local filesystem MVP. The documented upgrade path is an index or another store when measured volume makes the path hot. No other concern remains.
