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

## Review fixes: RED/GREEN

Five review findings were addressed in a second strict TDD cycle: access-log token leakage, shutdown waiting, canonical query syntax, sequential startup-window documentation, and singleton scheduler ownership.

### RED 1: logger, query, and ownership

Tests first added captured logger output for mixed-case and percent-encoded token keys, canonical query boundary/counterexamples, and an assertion that generic `buildApp()` construction never calls `reap()`.

```bash
npx vitest run apps/api/src/preview.test.ts --pool=threads --maxWorkers=1
```

Observed: 11 failed / 11 passed. Nine noncanonical coercible query forms incorrectly returned 200, the configured capture stream remained empty while the default logger emitted the raw token URL, and advancing the clock after `buildApp()` called `reap()` once.

### GREEN 1

The implementation added a centralized whitelisting request serializer with case-insensitive decoded-key token replacement, canonical decimal string schemas, and moved scheduler registration to an entrypoint-called focused helper. The same command then passed 22 / 22 tests.

### RED 2: active sweep shutdown

The initial shutdown assertion was tightened after it proved too weak: Fastify microtasks, rather than scheduler waiting, kept the close flag pending. The corrected test observes `schedule.stop()` directly while a reap promise is blocked.

```bash
npx vitest run apps/api/src/preview-reaper.test.ts --pool=threads --maxWorkers=1
```

Observed: 1 failed / 1 passed. `stop()` resolved before the blocked sweep settled.

### GREEN 2

The scheduler now retains the caught active promise, clears future ticks, and awaits that promise from `stop()`. A late rejected sweep is logged and does not become unhandled. Combined focused result:

```bash
npx vitest run apps/api/src/preview.test.ts apps/api/src/preview-reaper.test.ts --pool=threads --maxWorkers=1
```

Result: 2 files / 24 tests passed.

### Review-fix final verification

- Expanded preview matrix: 9 files / 119 tests passed.
- Root Prettier and ESLint: passed with zero warnings/errors.
- Root TypeScript project references: passed.
- Full Vitest: 60 files / 546 tests passed.
- Node script tests: 42 / 42 passed.
- Doctor: mock environment ready; Node, Git, harness, workflows, catalog, Codex, Claude, and AGY checks passed.
- `git diff --check`: passed.

### Detached fixture audit

After validation, PIDs 41102, 95859, and 95892 were confirmed as PPID-1 process-group leaders running this worktree's `packages/executors/src/fixtures/preview-dev-server.mjs` from `agent-foundry-preview-runner-*` temporary directories. They predated this Task 4 cycle. Only those confirmed groups were terminated (SIGTERM, then conditional SIGKILL); all three are gone, and the clean full run left no persistent matching fixture.

There is an existing test-cleanup gap outside Task 4's API scope: `node-preview-runner.test.ts` stops ordinary runner sessions only on the happy path, while its `afterEach` kills only PIDs explicitly added to `strayPids`. A failed/interrupted assertion before `runner.stop()` can therefore orphan an unregistered fixture. No executor test code was changed in this API wiring review fix.
