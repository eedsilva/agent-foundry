# Issue #16 Emergency Ceiling and Model Overrides Implementation Plan

> **For Codex:** REQUIRED SUB-SKILLS: use `superpowers:test-driven-development` for every task and `superpowers:subagent-driven-development` for sequential implementation/review waves. Apply `ponytail:ponytail` ultra and `karpathy-guidelines` throughout.

**Goal:** Remove normal attempt/iteration budgets, add policy-safe audited model pins, and stop pathological runs after four active hours or ten consecutive completed repairs while preserving failed work on a draft branch and restoring the verified workspace.

**Architecture:** Extend the existing persisted run/router/workspace flow rather than introducing a scheduler. Immutable model overrides live beside the run and are resolved at each agent-step boundary (retry, then step, then run). A compact optional execution-state record on `WorkflowRun` accumulates active milliseconds, consecutive repairs, the last verified Git checkpoint, and terminal ceiling evidence. The orchestrator checks that state at execution boundaries, uses the existing cancellation signal path, and delegates draft preservation/restoration to `WorkspaceManager`.

**Tech Stack:** TypeScript, Zod, file-backed repositories, Fastify, Next.js native forms, Vitest, Git CLI via `execa`.

**Stacking:** Base is reviewed issue #17 head `14cfc31`; branch `agent/issue-16-emergency-ceiling` remains based on `agent/issue-17-audit-feedback` until PR #160 merges.

## Non-negotiable invariants

- `maxAttempts` and `maxIterations` remain readable in legacy workflow YAML but do not terminate normal execution.
- Candidate lists remain finite: automatic execution tries the selected route and every router fallback once; any explicit pin tries exactly the pinned model and disables fallback.
- An override never bypasses ProjectPolicy, step `allowedProviders`, context capacity, or workspace-write capability.
- Active time excludes `paused` and `awaiting_approval`; persisted accounting survives process restart.
- The tenth completed consecutive repair and active time `>= 14_400_000ms` trigger the ceiling. A successful quality approval resets the repair counter.
- Ceiling handling preserves failed work at `draft/<runId>`, restores the active workspace to the last verified checkpoint, fails with `EMERGENCY_CEILING`, persists the draft branch, and emits one idempotent `run.emergency_ceiling_reached` event.
- Manual cancellation keeps precedence and remains idempotent at every step boundary and during executor/verifier work.

---

### Task 1: Contracts for immutable overrides and restart-safe ceiling state

**Files:**

- Modify: `packages/contracts/src/model.ts`
- Modify: `packages/contracts/src/run.ts`
- Modify: `packages/contracts/src/api.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/run.test.ts`
- Test: `packages/contracts/src/api.test.ts`

**Step 1 — RED:** Add failing schema tests for:

- `ModelOverrideRecord` with resolved `modelId/provider/model`, `run` or `step` scope, #17 `ActorRef`, nonempty reason, nonempty estimated impact, and timestamp.
- `WorkflowRun.execution` compatibility: active elapsed milliseconds, optional active-since timestamp, consecutive repairs, last verified checkpoint, optional ceiling/draft evidence.
- new run/step pin request and response schemas.
- retry override requiring actor/reason/estimated impact on new input while legacy persisted retry directives without those fields still parse.
- optional `RouteDecision.override` provenance that old route decisions can omit.

**Step 2 — Verify RED:** Run contract files and capture failures caused by missing schemas/fields.

**Step 3 — GREEN:** Add only optional/defaulted persisted fields. Keep old `maxAttempts`, `maxIterations`, route decisions, retry directives, runs, and decisions parse-compatible.

**Step 4 — Verify GREEN:** Run contract tests and typecheck.

**Step 5 — Commit:** `feat(contracts): define audited model overrides and ceiling state`

---

### Task 2: Immutable override repository, API, and policy-safe resolution

**Files:**

- Modify: `packages/domain/src/ports.ts`
- Create: `packages/persistence/src/model-override-repository.ts`
- Create: `packages/persistence/src/model-override-repository.test.ts`
- Modify: `packages/persistence/src/index.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `packages/orchestrator/src/project-service.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/model-router/src/score-router.ts`
- Modify: `packages/model-router/src/score-router.test.ts`
- Modify: `apps/api/src/app.ts`
- Create or modify: adjacent API override tests

**Step 1 — RED:** Prove:

- create-only file records survive repository reconstruction and list deterministically.
- `POST /runs/:runId/model-overrides` accepts run/step scope and resolves the catalog model before persistence.
- newest matching step override wins over newest run override.
- explicit retry metadata is retained on the retry directive and route decision.
- pinned models forbidden by policy, step provider restrictions, context, or workspace-write constraints are rejected before execution.
- accepted pins produce one candidate, no fallback, and visible route provenance.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Add one `ModelOverrideRepository` port and file implementation under the run directory. Reuse the router's existing rejection rules by adding a route-with-explicit-model path or shared constraint check; do not construct a zero-score catalog candidate that bypasses rejected models. Resolve retry → step → run at the agent-step boundary.

**Step 4 — Verify GREEN:** Persistence, router, orchestrator, API, and typecheck.

**Step 5 — Commit:** `feat(router): persist and enforce audited model pins`

---

### Task 3: Remove normal budgets and persist active execution accounting

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/domain/src/run-state.ts` (only if shared transition helpers are needed)
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Create: `packages/orchestrator/src/emergency-ceiling.test.ts`
- Modify: existing workflow/route compatibility tests

**Step 1 — RED:** Cover:

- all finite selected/fallback candidates are eligible even when legacy `maxAttempts` is `1`.
- quality loops continue past legacy `maxIterations`.
- active elapsed time accumulates while running and excludes persisted pause and approval waits across restart.
- at `14_399_999ms` execution may continue; at `14_400_000ms` it ceilings.
- each completed repair increments the consecutive counter; the tenth ceilings; a successful quality approval resets it to zero.
- an unrecoverable routing/execution error still fails normally before a ceiling.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Replace bounded quality `for` logic with a cancellation/ceiling-controlled loop. Replace the `slice(0, step.maxAttempts)` candidate cap with the finite router output. Persist accounting at status/step boundaries; do not count `paused` or `awaiting_approval` wall time.

**Step 4 — Verify GREEN:** Emergency ceiling, workflow, run-control, and cancellation suites.

**Step 5 — Commit:** `feat(orchestrator): enforce active-time and repair ceilings`

---

### Task 4: Preserve draft work and restore the last verified checkpoint

**Files:**

- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/workspace-manager.ts`
- Modify: `packages/persistence/src/workspace-manager.test.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/emergency-ceiling.test.ts`
- Modify: `packages/orchestrator/src/cancellation.test.ts`

**Step 1 — RED:** With a real temporary Git workspace prove:

- successful verification updates `lastVerifiedCheckpoint`.
- ceiling commits dirty/failed work to `draft/<runId>` (idempotently if replayed).
- active branch/worktree returns to the exact last verified checkpoint with dirty/untracked failed work absent.
- run error code is `EMERGENCY_CEILING`; draft branch is persisted; event is emitted once.
- restart during ceiling finalization converges without losing the draft or re-emitting evidence.
- cancellation during execution still aborts/rolls back and never creates a ceiling draft.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Add one workspace method that preserves the current tree on the named draft branch and restores the caller's active branch to a supplied checkpoint. Use ordinary Git commits/branches; no extra worktree or merge abstraction.

**Step 4 — Verify GREEN:** Workspace Git, ceiling, failure-injection, cancellation.

**Step 5 — Commit:** `feat(workspace): preserve ceiling drafts and restore verified head`

---

### Task 5: Native model-pin controls and visible ceiling evidence

**Files:**

- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/app/project/[id]/page.tsx`
- Modify: `apps/web/app/globals.css` only for existing-form layout reuse
- Create or modify: adjacent web helper/component tests
- Modify: API tests for run/step/retry pins

**Step 1 — RED:** Test pure helpers/request shaping for:

- run and step pin forms.
- retry pin fields.
- required actor kind/id, reason, and estimated impact.
- provider/model values from the catalog/runtime response, not freeform hidden defaults.
- visible active elapsed/repair count and ceiling draft branch/error state.

**Step 2 — Verify RED.**

**Step 3 — GREEN:** Reuse the current project page and native `<form>`, `<select>`, `<input>`, and `<textarea>` controls. No component library or state framework. Refresh run/project detail after submission and surface API errors inline.

**Step 4 — Verify GREEN:** Web unit/type/build tests and API integration.

**Step 5 — Commit:** `feat(web): add audited model pin and ceiling controls`

---

### Task 6: Documentation, evidence, and full release gate

**Files:**

- Create: `docs/adr/0016-emergency-ceiling-model-overrides.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/MODEL_ROUTING.md`
- Modify: `docs/VALIDATION.md`
- Reference: `docs/DEFINITION_OF_DONE.md`

**Step 1:** Document active-time semantics, override precedence/constraints, compatibility-on-read, draft recovery, cancellation precedence, security, migration, and rollback.

**Step 2:** Capture deterministic ceiling trace:

```text
verified checkpoint -> failed mutation -> tenth repair or 4h active
-> draft/<runId> commit -> active workspace reset to verified checkpoint
-> run failed EMERGENCY_CEILING -> event persisted once
```

**Step 3:** Run `npm run check`, `npm run doctor`, and `git diff --check`.

**Step 4:** Capture a project-page screenshot showing native pin controls and ceiling/draft status.

**Step 5:** Commit documentation/evidence, then request independent whole-branch review.

**Step 6:** Open the stacked PR against `agent/issue-17-audit-feedback` with `Closes #16`, run Ponytail review and code-simplifier over the PR diff, apply every actionable finding, rerun the full gate, push, and verify all nine GitHub checks.
