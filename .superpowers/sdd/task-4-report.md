# Task 4 report: runtime/API wiring and operational documentation

## Status

Complete. Runtime composition now supplies durable preview repositories, lifecycle lock, log-backed runner, artifacts/events, and the eight-argument `PreviewService`. Fastify owns the only preview reap schedule. The project-scoped logs endpoint, stop ownership check, current-run propagation, operations guide, validation record, and ADR 0018 are included.

## RED

Tests were added before production changes in:

- `packages/composition/src/config.test.ts`: exact lifecycle defaults and environment overrides.
- `apps/api/src/preview.test.ts`: cursor logs, query validation, logs/stop project ownership, current-run propagation, and non-overlapping scheduler behavior/error reporting/close cleanup.

Command:

```bash
npx vitest run packages/composition/src/config.test.ts apps/api/src/preview.test.ts --pool=threads --maxWorkers=1
```

Observed result: 2 files failed, 12 tests failed and 16 passed. The config assertions reported the seven missing lifecycle fields. API setup failed at the already-committed `PreviewService` eight-argument constructor because runtime still passed the former four arguments (`config` was undefined). These were the expected missing-wiring failures, not syntax or fixture errors.

## GREEN

Minimal implementation:

- Added the exact requested Zod defaults and `RuntimeConfig` fields.
- Reused `FilePreviewSessionRepository`, `FilePreviewLogRepository`, and `FilePreviewLifecycleLock`; no dependency or new abstraction.
- Injected the log repository and health path into `NodePreviewRunner`, and repositories/lock/artifacts/events/config into `PreviewService`.
- Added one unreferenced Fastify-owned interval. It skips overlapping ticks, logs rejected sweeps (including `AggregateError`), and clears on `onClose`. No worker scheduler exists.
- Added the project-scoped logs route with `cursor >= 0`, `1 <= limit <= 200`, repository/service default limit, durable ownership lookup, and the same lookup on stop.
- Preserved start/stop response objects and associated `project.currentRunId` on start when present.
- Updated `OPERATIONS.md`, `VALIDATION.md`, and added ADR 0018 for configuration, storage, redaction, security, PID assumptions, migration, rollback, diagnostics, recovery, and evidence.

First GREEN command:

```bash
npx vitest run packages/composition/src/config.test.ts apps/api/src/preview.test.ts --pool=threads --maxWorkers=1
```

Result: 2 files passed, 28 tests passed.

Relevant preview matrix:

```bash
npx vitest run packages/contracts/src/preview.test.ts packages/persistence/src/preview-repositories.test.ts packages/executors/src/preview-port.test.ts packages/executors/src/node-preview-runner.test.ts packages/orchestrator/src/preview-service.test.ts packages/composition/src/config.test.ts apps/api/src/preview.test.ts apps/api/src/preview-proxy.test.ts --pool=threads --maxWorkers=1
```

Result: 8 files passed, 105 tests passed.

## Full checks

The following chained gate completed successfully:

```bash
npm run format:check && npm run lint && npm run typecheck && npm test && npm run doctor && git diff --check
```

Evidence:

- Prettier: all files matched.
- ESLint: zero warnings/errors.
- TypeScript project references: passed.
- Vitest: 59 files / 532 tests passed.
- Node script tests: 42 / 42 passed.
- Doctor: mock environment ready; Node, Git, harness, workflows, catalog, Codex, Claude, and AGY checks passed.
- `git diff --check`: passed.

## Concerns and boundaries

- Lifecycle-lock recovery assumes one host PID namespace for every process sharing `DATA_DIR`; this is documented in operations and ADR 0018.
- There is deliberately no migration of old preview sessions because the previous implementation stored them only in memory. Operators must stop old preview processes during rollout/rollback.
- Redaction is defense in depth, not permission to publish local logs or diagnostic artifacts; `DATA_DIR` remains sensitive.
