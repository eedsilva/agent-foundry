# Plan: Harden preview failure evidence and repair retention (#346)

Spec: GitHub issue #346 (`[v0.10.5] Harden preview failure evidence and repair retention`).
Follow-up to #320 / PR #343 (ADR 0040).

## Context

`PreviewService` (packages/orchestrator/src/preview-service.ts) emits a `preview.failed`
project event carrying a `PreviewFailureDiagnostic`. `NodePreviewRunner`
(packages/executors/src/node-preview-runner.ts) captures subprocess evidence.
The repair prompt (`compileRequestMarkdown`, packages/orchestrator/src/prompt-compiler.ts)
renders `event.data.diagnostic ?? event.data` for the latest `preview.failed` event.

Four gaps remain after #343:

1. Evidence is only attached to the session on the **spawn** failure path. A dev server that
   becomes healthy and later crashes loses its exit code and captured stdout/stderr — the
   diagnostic falls back to the log tail only.
2. `maxOutputBytes` is applied with `String.prototype.slice`, which counts UTF-16 code units,
   not UTF-8 bytes. Multibyte output can exceed the byte budget and a slice can split a
   surrogate pair. The service-side diagnostic `output` built from the log-tail fallback is
   not byte-bounded at all.
3. Repair lookup does `[...(await this.events.list(projectId))].reverse().find(...)`.
   `EventStore.list` defaults to the newest 500 events, so a preview failure older than
   500 project events is invisible to repair. Duplicated at two call sites
   (workflow-orchestrator.ts, conversation-operation-runner.ts).
4. When the found `preview.failed` event has no embedded `diagnostic` (an event written
   before #343), nothing reads the legacy `preview-failure-<sessionId>` artifact, so repair
   gets `data` with no evidence.

Plus: no production event-store test covers a persisted `preview.failed` diagnostic or its
redaction, and `docs/VALIDATION.md` has no section for this work while ADR 0018 still states
that terminal diagnostics are written to a `preview-failure-<sessionId>` artifact —
contradicting ADR 0040.

## Global Constraints

- **Worktree**: all work happens in `/Users/edsilva/Documents/ed/agent-foundry-wt-346` on
  branch `feat/346-preview-failure-evidence`. Never `cd` back to the main checkout, and never
  pass an absolute path into the main checkout to Write/Edit.
- **TDD is mandatory.** For every behavior change: write the failing test first, run it and
  observe the failure, then implement, then observe it pass. Report the red output and the
  green output.
- **Ponytail / YAGNI.** Shortest working diff. No new abstractions, no new dependencies, no
  new env vars, no new port methods unless the plan says so. Reuse what exists.
- **Per-task typecheck is mandatory.** Any task touching `.ts` must run
  `npx tsc -b` from the worktree root (or the touched packages' tsconfigs) and report the
  output. `exactOptionalPropertyTypes` is on — `{ foo: maybeUndefined }` does not satisfy
  `foo?: T`; use conditional spread (`...(x !== undefined ? { foo: x } : {})`), matching the
  surrounding code.
- **Non-goals from the issue (hard):** do not mint new versioned artifacts for new preview
  failures; do not delete existing legacy `preview-failure-*` artifacts.
- Comment only where the *why* is non-obvious; match the surrounding comment density.
- Mark any deliberate corner-cut with a `ponytail:` comment naming the ceiling and the
  upgrade path (the codebase already uses this convention).
- Commit at the end of each task with a conventional-commit subject.
- Never run `npm run check` (too slow for the inner loop); run the focused vitest files you
  touched plus `npx tsc -b`. The controller runs the full gate once at the end.

## Task 1 — UTF-8 byte bound for captured and emitted evidence

**Files:** `packages/domain/src/utils.ts`, `packages/domain/src/utils.test.ts`,
`packages/domain/src/index.ts` (only if `utils.ts` exports are not already re-exported),
`packages/executors/src/node-preview-runner.ts`,
`packages/executors/src/node-preview-runner.test.ts`,
`packages/orchestrator/src/preview-service.ts`,
`packages/orchestrator/src/preview-service.test.ts`.

**Acceptance criterion (issue):** "Multibyte output remains valid UTF-8 and never exceeds the
configured byte budget."

### 1a. `tailBytes` helper in `packages/domain/src/utils.ts`

Export exactly this shape (name it `tailBytes`):

```ts
/**
 * Keeps the last `maxBytes` UTF-8 bytes of `text`, trimming forward to the next
 * code-point boundary so a truncated tail is never invalid UTF-8. `String.slice`
 * counts UTF-16 code units, which both overshoots a byte budget on multibyte
 * output and can split a surrogate pair.
 */
export function tailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  let start = buffer.byteLength - maxBytes;
  // 10xxxxxx is a UTF-8 continuation byte; advance past the partial code point
  // rather than emitting a replacement character.
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}
```

Tests (write first, in `packages/domain/src/utils.test.ts`, alongside the existing describes):

- ASCII under the budget is returned unchanged.
- ASCII over the budget keeps exactly the last `maxBytes` bytes.
- A string of 3-byte characters (e.g. `'é'.repeat(...)` is 2-byte; use `'☃'` at 3 bytes or
  `'🙂'` at 4 bytes) bounded to a budget that lands mid-character yields a string whose
  `Buffer.byteLength(result, 'utf8') <= maxBytes` and that contains no `�`
  replacement character.
- A 4-byte emoji is never split into a lone surrogate: assert the result round-trips
  (`Buffer.from(result, 'utf8').toString('utf8') === result`) and has no `�`.
- `maxBytes` of 0 returns `''`.

Verify the export is reachable as `import { tailBytes } from '@agent-foundry/domain'` —
check how `stableJson` from the same file is re-exported and follow that exact pattern.

### 1b. Runner uses byte bounds

In `packages/executors/src/node-preview-runner.ts`, replace every
`.slice(-this.maxOutputBytes)` with `tailBytes(..., this.maxOutputBytes)`. There are four
sites: the install-failure `message`, the install-failure `stdout` and `stderr`, and the
streaming accumulator in `attemptSpawn`'s `capture`.

The streaming accumulator currently reads:

```ts
entry.output[stream] = `${entry.output[stream]}${text}`.slice(-this.maxOutputBytes);
```

Replace with `tailBytes(`${entry.output[stream]}${text}`, this.maxOutputBytes)` and add a
`ponytail:` comment noting the ceiling: this re-encodes the whole retained buffer on every
chunk (O(n) per chunk, same order as the previous `slice`), upgrade path is a chunk ring
buffer if capture ever becomes hot.

Test (write first, in `node-preview-runner.test.ts`, following the existing test style):
construct a runner with a small `maxOutputBytes` (e.g. 16) whose dev command writes
multibyte output, and assert the resulting `failureEvidence.stderr` (or `stdout`) satisfies
`Buffer.byteLength(value, 'utf8') <= 16` and contains no `�`.

### 1c. Service bounds the emitted diagnostic output

In `packages/orchestrator/src/preview-service.ts`, add a module-level constant next to
`DIAGNOSTIC_LOG_LIMIT`:

```ts
const DIAGNOSTIC_MAX_OUTPUT_BYTES = 1_000_000;
```

In `loadOrBuildFailureDiagnostic`, apply `tailBytes(..., DIAGNOSTIC_MAX_OUTPUT_BYTES)` to
both `output.stdout` and `output.stderr` **after** `redactString` (redaction can grow a
string, so bounding before it is not a bound), on both branches — the
`session.failureEvidence` branch and the joined-log-tail fallback branch. Prefer bounding the
final `output` object once rather than duplicating the call on four expressions.

Do **not** add a new config field or env var; the constant is the budget.

Test (write first, in `preview-service.test.ts`, following the existing test style): drive a
session to terminal failure with evidence whose redacted output exceeds the budget (or stub
the log tail so the joined fallback does), and assert the emitted `preview.failed` event's
`data.diagnostic.output.stdout`/`.stderr` are within `DIAGNOSTIC_MAX_OUTPUT_BYTES` bytes and
free of `�`. Keep the test's own budget expectation derived from the exported/again
declared constant value, not a second hardcoded number in the assertion prose.

**Verification for Task 1:**
`npx vitest run packages/domain/src/utils.test.ts packages/executors/src/node-preview-runner.test.ts packages/orchestrator/src/preview-service.test.ts`
and `npx tsc -b`.

## Task 2 — Preserve runtime evidence when a healthy server later crashes

**Files:** `packages/executors/src/node-preview-runner.ts`,
`packages/executors/src/node-preview-runner.test.ts`,
`packages/orchestrator/src/preview-service.ts`,
`packages/orchestrator/src/preview-service.test.ts`.

**Acceptance criterion (issue):** "A healthy-then-crashed preview emits `preview.failed` with
exit code and bounded captured output."

The runner already tracks the live process in `this.processes`: `markExited` records
`entry.exitCode` and `capture` accumulates `entry.output` for the whole lifetime of the
process, not just the startup window. The evidence exists; nothing carries it to the service
once startup succeeded.

`PreviewService.finalizeFailure` calls `await this.runner.stop(session)` and **discards the
returned session**. That returned session is the carrier — no new port method.

### 2a. `NodePreviewRunner.stop` returns the captured evidence

Change `stop(session)` so that when a tracked entry exists and has exited, the returned
session carries `failureEvidence` built from that entry: `exitCode` (only when defined —
`exactOptionalPropertyTypes`), `stdout`, `stderr` (both already byte-bounded by Task 1), and
`command` from `session.process` when present.

Ordering matters: `killTracked` deletes the entry from `this.processes`, so read the entry
(or snapshot the evidence) **before** calling `killTracked`.

Preserve today's behavior otherwise: `stop` on a session that is already
`isPreviewSessionTerminal` still returns that session unchanged; a session with no tracked
entry still behaves exactly as before. Do not attach evidence when the tracked process has
not exited (a healthy session being stopped on purpose is not a failure).

Do not overwrite an existing `session.failureEvidence` — the spawn path's evidence is more
specific.

Test (write first): start a session through the runner so it becomes healthy, kill the
underlying process, then call `stop()` and assert the returned session's `failureEvidence`
carries the process exit code and the captured stderr. Follow the existing tests' pattern for
spawning a real short-lived node dev server and for the unconditional tracked-session cleanup
after each test.

### 2b. `PreviewService.finalizeFailure` adopts it

In `finalizeFailure`, capture the result of `this.runner.stop(session)` and, when the current
session has no `failureEvidence` and the stopped session does, adopt it onto `session` before
building the diagnostic. The existing final
`this.persist(transitionPreviewSession(session, 'failed', failedAt))` then persists it, and
`FilePreviewSessionRepository` redacts `failureEvidence.stdout`/`.stderr` on write
(packages/persistence/src/preview-repositories.ts) — do not add a second redaction there.

`loadOrBuildFailureDiagnostic` already prefers `session.failureEvidence` for `output`,
`command`, and `exitCode`, so no change is needed inside it beyond Task 1's bound.

Test (write first, in `preview-service.test.ts`): with a fake runner whose `stop()` returns a
session carrying `failureEvidence` while the failing session carries none (the
healthy-then-crash shape: the session reached `running`, then health checks tripped the
failure threshold), assert the emitted `preview.failed` event's `data.diagnostic` has the
exit code and the captured output, and that `phase` is the runtime/health phase the existing
code assigns. Follow the existing fake-runner and `InMemoryEventStore` patterns in that file.

**Verification for Task 2:**
`npx vitest run packages/executors/src/node-preview-runner.test.ts packages/orchestrator/src/preview-service.test.ts`
and `npx tsc -b`.

## Task 3 — Reliable repair lookup + legacy artifact compatibility on read

**Files:** new `packages/orchestrator/src/preview-failure-lookup.ts` and
`packages/orchestrator/src/preview-failure-lookup.test.ts`,
`packages/orchestrator/src/workflow-orchestrator.ts`,
`packages/orchestrator/src/conversation-operation-runner.ts`,
`packages/orchestrator/src/index.ts` (only if the package re-exports modules there — check
first; do not export it publicly if nothing outside the package needs it).

**Acceptance criteria (issue):** "Repair context still receives the latest relevant preview
diagnostic after more than 500 project events." and "Legacy preview failure artifacts remain
readable and can supply repair context when event data is incomplete."

Both existing call sites duplicate the same broken lookup. Fix it once, in one shared helper
both call sites route through — do not patch only one caller.

### 3a. The helper

```ts
export async function latestPreviewFailureEvent(
  events: EventStore,
  artifacts: ArtifactStore,
  projectId: string,
): Promise<ProjectEvent | undefined>
```

Behavior:

1. **Widening scan.** `EventStore.list(projectId, limit)` returns the newest `limit` events
   in ascending order (verify this against `packages/persistence/src/event-store.ts` and
   `packages/persistence/src/postgres/event-store.ts` before writing code). Start at the
   store's own default page size (500), scan the page from newest to oldest for
   `type === 'preview.failed'`, and if not found, widen the limit geometrically (e.g. ×4) and
   re-list. Stop and return `undefined` when a page comes back with **fewer events than the
   requested limit**, which means the whole history was scanned. This terminates for any
   history size without a hardcoded ceiling.
   Add a `ponytail:` comment: re-listing a widening window is O(history) in the worst case;
   the upgrade path is a store-level `latest event of type` query (indexed on
   `(project_id, type)` in Postgres) if this ever becomes hot.
2. **Legacy compatibility on read.** When the found event's `data.diagnostic` is absent (an
   event written before #343) and `data.sessionId` is a string, read
   `artifacts.getLatest(projectId, \`preview-failure-${sessionId}\`)`. If it exists, return a
   copy of the event with `data.diagnostic` set to the artifact's `content`. Never mutate the
   stored event, never write a new artifact, never delete the legacy artifact.
   If the artifact is missing or the lookup throws, return the event unchanged — repair with
   partial context beats repair with none.

Note: `PreviewService.loadOrBuildFailureDiagnostic` already reads the legacy artifact on the
**write** path. This task adds the read-path fallback for events that predate the embedded
diagnostic. Do not touch the write path.

Tests (write first, in `preview-failure-lookup.test.ts`) with in-memory fakes — copy the
`InMemoryEventStore` shape from `packages/orchestrator/src/preview-service.test.ts` or reuse
`packages/orchestrator/src/testing/harness.ts`'s `InMemoryEvents` if it fits:

- Returns the newest `preview.failed` when several exist within the first page.
- **Finds a `preview.failed` buried behind more than 500 later events** (this is the
  regression test for the issue; make the fake's `list` honor `limit` exactly the way
  `FileEventStore` does — newest-`limit`, ascending).
- Returns `undefined` when the project has no `preview.failed` event, and does so without
  looping forever on a short history.
- Enriches an event whose `data` has no `diagnostic` from the legacy
  `preview-failure-<sessionId>` artifact.
- Leaves the event untouched when the legacy artifact is absent, and when `data.diagnostic`
  is already present (the artifact must not be consulted at all in that case — assert the
  fake artifact store was not called).

### 3b. Both call sites use it

Replace the inline lookup in `packages/orchestrator/src/workflow-orchestrator.ts` (~line 3120,
the `step.taskKind === 'repair'` branch) and in
`packages/orchestrator/src/conversation-operation-runner.ts` (~line 246, the
`operation.kind === 'repair'` branch) with a call to the helper, passing each class's existing
`this.events` and `this.artifacts`. Both classes already hold both dependencies — do not add
constructor parameters. Keep the `previewFailureEvents` field shape (`ProjectEvent[]`,
omitted when there is no event) exactly as it is today.

**Verification for Task 3:**
`npx vitest run packages/orchestrator/src/preview-failure-lookup.test.ts packages/orchestrator/src/prompt-compiler.test.ts`
plus any existing orchestrator test that covers the repair prompt's preview section, and
`npx tsc -b`.

## Task 4 — Production event-store coverage for diagnostic persistence and redaction

**Files:** `packages/persistence/src/event-store.test.ts`,
`packages/persistence/src/postgres/event-store.test.ts`. Test-only task — do not change
production code. If a test reveals a production bug, report it as a concern rather than
silently widening the task.

**Acceptance criterion (issue):** "File and Postgres event-store tests cover persisted
diagnostic fields and secret redaction."

Both stores run `redactEvent(ProjectEventSchema.parse(event))` on append. Nothing today
proves a `preview.failed` event's nested `data.diagnostic` survives the round trip with its
structure intact and its secrets removed.

For **each** store, add tests that append a realistic `preview.failed` event whose
`data.diagnostic` is a valid `PreviewFailureDiagnostic` (build it against
`PreviewFailureDiagnosticSchema` in `packages/contracts/src/preview.ts`; see the fixture in
`packages/contracts/src/preview.test.ts` around line 386 for a valid shape) and then `list()`
it back, asserting:

- The nested diagnostic survives the round trip: `sessionId`, `phase`, `exitCode`, `command`,
  `logs` entries/cursors, and `output.stdout`/`.stderr` are all present and equal to what was
  appended (modulo redaction).
- A secret planted in the diagnostic's free text (use a value that
  `packages/domain/src/redaction.ts`'s `redactString` actually matches — read that file and
  its tests first, and assert against the placeholder that implementation produces) is not
  readable in the listed event, in both `output.stderr` and a `logs.entries[].message`.
- Recovery-critical structure is not mangled by redaction: the command/args and the numeric
  cursors come back unchanged.

The Postgres file uses the existing suite's harness (`packages/persistence/src/postgres/testing.ts`,
`global-setup.ts`) — follow the neighbouring tests in that same file for setup/teardown and
skip conditions exactly; do not invent a new harness. This bucket is in the slow test list and
runs with `--maxWorkers=1`.

**Verification for Task 4:**
`npx vitest run packages/persistence/src/event-store.test.ts` and
`npx vitest run packages/persistence/src/postgres/event-store.test.ts`. If the Postgres suite
cannot run locally (no database available), say so explicitly in the report with the exact
error — do not claim it passed.

## Task 5 — Documentation: VALIDATION.md and ADR reconciliation

**Files:** `docs/VALIDATION.md`, `docs/adr/0018-durable-preview-lifecycle.md`,
`docs/adr/0040-preview-failure-events.md`. Docs-only task — no code changes.

**Acceptance criterion (issue):** "Validation and ADR documentation describe event-based
diagnostics, legacy compatibility, and repair lookup behavior."

**Scope discipline:** use exact `old_string`/`new_string` anchors. Before committing, run
`git diff --stat` and confirm the changed line counts match the edits you intended — a prior
session let a docs subagent delete ~200 unrelated lines. Do not reflow, reformat, or
re-order any paragraph you were not asked to change.

### 5a. `docs/adr/0018-durable-preview-lifecycle.md`

One sentence in the Decision section currently reads:

> Redaction occurs before log persistence; terminal diagnostics are redacted again before the
> existing artifact store writes `preview-failure-<sessionId>`.

This contradicts ADR 0040. Amend that sentence (and only it, plus the "Recovery starts with
… and failure artifact" sentence in Consequences if it still implies new artifacts are
written) to say that terminal diagnostics are redacted and emitted on the `preview.failed`
event, that ADR 0040 superseded the artifact write, and that legacy
`preview-failure-<sessionId>` artifacts remain readable. Add an explicit
`Superseded in part by ADR 0040` pointer near the top of the ADR, matching however this repo
already cross-references superseding ADRs (check `docs/adr/README.md` and a couple of other
ADRs for the existing convention before inventing one).

### 5b. `docs/adr/0040-preview-failure-events.md`

Extend the Decision/Consequences with the behavior added by Tasks 1–3, in the ADR's existing
terse bullet style:

- runtime evidence (exit code and bounded output) is preserved when a healthy server later
  crashes, not only when it fails to start;
- captured and emitted evidence is bounded by UTF-8 **bytes**, and truncation never produces
  invalid UTF-8;
- repair lookup scans the whole project event history for the latest `preview.failed`, not
  just the store's default page;
- a `preview.failed` event with no embedded diagnostic falls back on read to the legacy
  `preview-failure-<sessionId>` artifact.

Add the `Amends ADR 0018` relationship to match 5a.

### 5c. `docs/VALIDATION.md`

Add one new dated section following the file's existing section conventions exactly (read two
or three neighbouring sections first — the `## Durable preview lifecycle — 2026-07-16`
section at line ~132 and the `## Preview panel raw-error regression (#486) — 2026-08-11`
section at line ~658 are the models). Title it for this issue and date it `2026-08-14`. It
must state, with the concrete test-file paths this branch actually touched:

- what event-based diagnostics replaced (versioned failure artifacts) and what remains
  readable (legacy artifacts);
- the healthy-then-crash runtime evidence path and its covering tests;
- the UTF-8 byte bound on captured and emitted evidence and its covering tests;
- the repair lookup's whole-history scan and the legacy read fallback, and their covering
  tests;
- the file and Postgres event-store diagnostic/redaction coverage.

Only list test files that exist on this branch — verify each path with `ls` before writing it.

**Verification for Task 5:** `npx prettier --check docs/VALIDATION.md docs/adr/0018-durable-preview-lifecycle.md docs/adr/0040-preview-failure-events.md`
(or the repo's documented docs lint — check `package.json` scripts first) and
`git diff --stat` showing only the intended lines.
