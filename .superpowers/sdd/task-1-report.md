# Task 1 report: actor-aware persisted feedback and audit export

## Status

DONE

## Implementation

- Added canonical `ActorRef` (`user`, `system`, `worker`, `provider`), typed feedback artifact and
  metadata, optional approval actor compatibility, retry feedback reference, and deterministic run
  audit contracts.
- Normalized legacy `decidedBy` input to a user actor while retaining `decidedBy` on every new
  decision.
- Redacted approval notes before decision/artifact persistence, including nested sensitive keys and
  raw authorization, token, and cookie strings.
- Reused the configured repair artifact and existing artifact store. Its exact name, revision, and
  SHA-256 flow through the retry directive, retried attempt inputs, run record, and request markdown.
- Added `GET /runs/:runId/audit`, reconstructed from existing approval and artifact stores and sorted
  by timestamp then stable identifier.
- Updated the web approval client to submit a typed user actor.
- Documented security, migration, rollback, reproduction, and validation in ADR 0015 and operations
  docs. No dependency or feedback-specific repository was added.

## Files changed

- `.superpowers/sdd/task-1-report.md`
- `apps/api/src/app.ts`
- `apps/api/src/approvals.test.ts`
- `apps/web/app/project/[id]/page.tsx`
- `docs/OPERATIONS.md`
- `docs/VALIDATION.md`
- `docs/adr/0015-actor-feedback-audit.md`
- `docs/superpowers/plans/2026-07-16-issue-17-audit-feedback.md` (Prettier-only cleanup required by the gate)
- `packages/contracts/src/api.test.ts`
- `packages/contracts/src/api.ts`
- `packages/contracts/src/primitives.ts`
- `packages/contracts/src/project.ts`
- `packages/contracts/src/run.test.ts`
- `packages/contracts/src/run.ts`
- `packages/domain/src/ports.ts`
- `packages/domain/src/redaction.test.ts`
- `packages/domain/src/redaction.ts`
- `packages/orchestrator/src/approval-gate.test.ts`
- `packages/orchestrator/src/project-service.ts`
- `packages/orchestrator/src/prompt-compiler.test.ts`
- `packages/orchestrator/src/prompt-compiler.ts`
- `packages/orchestrator/src/testing/harness.ts`
- `packages/orchestrator/src/workflow-orchestrator.ts`
- `packages/persistence/src/artifact-store.test.ts`
- `packages/persistence/src/artifact-store.ts`

## TDD evidence

### RED 1: contracts and redaction

Command:

```text
npx vitest run packages/contracts/src/run.test.ts packages/contracts/src/api.test.ts packages/domain/src/redaction.test.ts
```

Exit: `1`.

Exact result summary:

```text
Test Files  3 failed (3)
Tests  6 failed | 20 passed (26)
```

Expected failure reasons observed:

```text
(0 , redactUnknown) is not a function
Invalid input: expected string, received undefined (typed actor without decidedBy)
Cannot read properties of undefined (reading 'parse') (ActorRef/FeedbackArtifact/RunAuditExport)
Unrecognized key: "actor" (ApprovalDecision)
```

### GREEN 1: contracts and redaction

Command:

```text
npx vitest run packages/contracts/src/run.test.ts packages/contracts/src/api.test.ts packages/domain/src/redaction.test.ts
```

Exit: `0`.

Exact output:

```text
Test Files  3 passed (3)
Tests  26 passed (26)
```

### RED 2: persistence, orchestrator, prompt compiler, and API

Command:

```text
npx vitest run packages/persistence/src/artifact-store.test.ts packages/orchestrator/src/approval-gate.test.ts packages/orchestrator/src/prompt-compiler.test.ts apps/api/src/approvals.test.ts
```

Exit: `1`.

Exact result summary:

```text
Test Files  4 failed (4)
Tests  4 failed | 12 passed (16)
```

Expected failure reasons observed:

```text
feedback metadata omitted kind/actor/sourceDecisionId
typed actor was not normalized and note remained unredacted
request markdown omitted SHA-256
typed actor API request returned 400 before the audit endpoint could be exercised
```

### GREEN 2: persistence, orchestrator, prompt compiler, and API

Command:

```text
npx vitest run packages/persistence/src/artifact-store.test.ts packages/orchestrator/src/approval-gate.test.ts packages/orchestrator/src/prompt-compiler.test.ts apps/api/src/approvals.test.ts
```

Exit: `0`.

Exact output:

```text
Test Files  4 passed (4)
Tests  16 passed (16)
```

This includes a fresh `FileArtifactStore` instance reconstructing the same feedback revision/hash
from the same filesystem data, and the HTTP audit export containing the request, decision,
feedback, and subsequent request in deterministic order.

### Focused compatibility/type gate

Command and output:

```text
npm run typecheck
> tsc -b --force --pretty false
```

Exit: `0`.

## Full validation

### `npm run check`

The first invocation stopped at `format:check` because four files were not Prettier-clean. The
formatter was applied only to those files; the successful rerun exited `0` with:

```text
All matched files use Prettier code style!
architecture ok: 11 workspaces, no forbidden edges or cycles
roadmap ok: 16 milestones, 114 tasks, 131 managed issues
github config ok: 4 issue forms, 3 workflows, 10 check contexts
planning/ROADMAP.md está sincronizado.
Test Files  41 passed (41)
Tests  312 passed (312)
scripts: 42 passed, 0 failed
all package builds passed
API and worker builds passed
Next.js: Compiled successfully; 3/3 static pages generated
```

### `npm run doctor`

Exit: `0`.

```text
Agent Foundry doctor · executor mode: mock
✓ node                 v22.22.3
✓ git                  git version 2.50.1 (Apple Git-155)
✓ harness manifest
✓ workflow directory
✓ model catalog
✓ codex                Codex is ready.
✓ claude               Claude is ready.
✓ agy                  AGY is ready.
Environment is ready.
```

### `git diff --check`

Exit: `0`; no output.

## Concerns

None. The audit export intentionally performs a linear scan of project artifact metadata; ADR 0015
records the measured-performance threshold for introducing an index later.
