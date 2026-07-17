# Preview Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable preview health, bounded restart, cursor-based redacted logs, orphan cleanup, and structured repair diagnostics for issue #31.

**Architecture:** Extend the existing `PreviewRunner` and `PreviewService` seams introduced by issue #30. Persist versioned preview sessions and bounded structured logs under `DATA_DIR/previews`, keep raw access tokens out of storage, and let an API-owned reaper drive deterministic lifecycle sweeps. Terminal failures create a redacted artifact for later repair orchestration; they do not enqueue repair automatically.

**Tech Stack:** Node.js 22+, TypeScript, Zod, Fastify, Vitest, existing npm workspaces and Node built-ins only.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-31-preview-lifecycle` on `agent/issue-31-preview-lifecycle`.
- Follow strict RED -> GREEN -> REFACTOR for every behavior; no production code before a correctly failing test.
- Keep existing preview start, stop, proxy URL, token, and session response shapes compatible.
- Persist only a SHA-256 token digest; never persist a raw preview access token.
- Redact preview logs before they reach disk.
- Add no npm dependency.
- Do not automatically enqueue repair.
- `npm run check`, `npm run doctor`, and `git diff --check` must pass before publication.

---

### Task 1: Contracts and file-backed persistence

**Files:** `packages/contracts/src/preview.ts`, `packages/domain/src/ports.ts`, `packages/persistence/src/preview-repositories.ts`, and colocated tests/exports.

**Interfaces:**

- `PreviewRunner.logs(session, { cursor?, limit? }): Promise<PreviewLogPage>`
- `PreviewSessionRepository`: `create`, `get`, `listActive`, `update`
- `PreviewLogRepository`: `append`, `list`
- Structured log entries preserve stdout/stderr, use monotonic cursors, and pages report `truncatedBeforeCursor` when retention dropped earlier data.

- [ ] Write contract tests for log pages and failure diagnostics; run them and verify RED.
- [ ] Add the minimal Zod schemas/types and update the `PreviewRunner` signature; run and verify GREEN.
- [ ] Write persistence tests for optimistic session updates, token-digest storage, cursor pagination, redaction-before-disk, and byte-bounded truncation; run and verify RED.
- [ ] Implement file repositories under `DATA_DIR/previews/<sessionId>/`; run and verify GREEN.
- [ ] Refactor only touched code, rerun targeted tests, and commit.

### Task 2: Runner health, logging, crash detection, and process-tree termination

**Files:** `packages/executors/src/node-preview-runner.ts`, the existing CLI process-tree helper, the preview dev-server fixture, and colocated tests.

**Interfaces:** Consumes Task 1 log types/repository. Produces HTTP health probing, structured persisted stdout/stderr, independent exit detection, and SIGTERM -> 2-second grace -> SIGKILL process-tree cleanup.

- [ ] Write failing tests for HTTP-vs-TCP health, stdout/stderr capture, immediate exit, and process-tree cleanup.
- [ ] Reuse/extract the existing CLI process-group kill behavior and implement the minimal runner changes.
- [ ] Preserve the existing single initial respawn for bind conflict; do not add lifecycle restart policy to the runner.
- [ ] Run targeted tests, refactor only after green, and commit.

### Task 3: Durable service lifecycle, bounded restart, reaper, and repair diagnostics

**Files:** `packages/orchestrator/src/preview-service.ts`, a focused preview reaper module if scheduling cannot remain local, and colocated tests.

**Interfaces:**

- `PreviewService.logs(sessionId, cursor?, limit?)`
- `PreviewService.reap()` performs one deterministic sweep.
- Defaults: startup `10000ms`, health path `/`, interval `1000ms`, failure threshold `3`, maximum restarts `2`, reap interval `5000ms`, log retention `1000000` bytes.

- [ ] Write failing tests for slow startup, never-healthy port, two-restart crash loop, TTL/orphan cleanup, concurrent sweeps, deduplicated events/artifacts, and structured failure diagnostics.
- [ ] Replace the in-memory session map with repositories while retaining raw tokens only in memory/response cookies.
- [ ] Persist all transitions and emit deduplicated `preview.crashed`, `preview.restarted`, `preview.failed`, and `preview.reaped` events.
- [ ] Store `preview-failure-<sessionId>` as a redacted artifact linked to project/current run; do not enqueue repair.
- [ ] Run targeted tests, refactor only after green, and commit.

### Task 4: Runtime/API wiring and operational documentation

**Files:** `packages/composition/src/config.ts`, `packages/composition/src/runtime.ts`, `apps/api/src/app.ts`, API lifecycle entrypoint, `docs/OPERATIONS.md`, `docs/VALIDATION.md`, and a new ADR.

- [ ] Write failing config/API tests for exact defaults and `GET /projects/:projectId/preview/:sessionId/logs?cursor=<n>&limit=<1..200>`.
- [ ] Wire repositories, service config, and an API-owned start/stop reaper schedule without changing existing start/stop response shapes.
- [ ] Document storage, configuration, redaction, security, migration, rollback, diagnostics, and operational recovery.
- [ ] Run targeted tests, refactor only after green, and commit.

### Task 5: Verification, publication, and post-PR quality gates

- [ ] Run all targeted preview tests, `npm run check`, `npm run doctor`, and `git diff --check`.
- [ ] Run task reviews after each task and a whole-branch correctness review; fix every Critical/Important finding and rerun covering tests.
- [ ] Push and open one PR to `main` with `Closes #31`, observable evidence, and security/migration/rollback notes.
- [ ] Run `ponytail-review` and `code-simplifier-v2` against only the issue diff; apply every safe applicable finding, rerun full validation, and push.
- [ ] Comment evidence on issue #31 and verify all required GitHub checks are green with no unresolved review findings.
