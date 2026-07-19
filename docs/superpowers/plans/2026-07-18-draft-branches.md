# Draft Branches for Emergency-Ceiling Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user inspect, retry, or discard the git branch that preserves a failed (emergency-ceiling) run's work, without ever overwriting the last verified good version.

**Architecture:** The ceiling-detection, draft-branch-creation, and workspace-rollback machinery already exists and is already tested (`WorkflowOrchestrator` + `FileWorkspaceManager`, see the design spec). This plan only (1) persists one value (`draftCommit`) that was already computed but thrown away, (2) adds three small `ProjectService` methods (`getDraft`, `discardDraft`, an extended `retry`) that reuse existing repositories/ports, (3) exposes them over three small API routes, and (4) wires a diff/discard/retry panel into the existing project page using components that already exist (`DiffView`, `ModelPinFields`).

**Tech Stack:** TypeScript, Zod (contracts), Fastify (API), vitest (tests), Next.js/React (web, no test framework for `.tsx` — matches existing repo convention).

## Global Constraints

- Every new/changed field in `packages/contracts` is additive and optional — no migration for existing persisted `WorkflowRun`/`ProjectEvent` records (see design spec "contracts" section).
- Branch names are already derived from `runId` through `safeSegment` (`packages/persistence/src/fs-utils.ts`) before reaching git — do not introduce a second, unsanitized path to a git branch argument.
- Do not add a new persisted "draft" entity/table/repository — everything lives on the existing `WorkflowRun.execution.ceiling` plus the existing `ProjectEvent` log (design spec, "Approaches considered", B).
- Do not implement repair-loop/ceiling tracking for `ConversationOperationRunner` — out of scope (design spec, Assumption 1).
- Never auto-promote a draft into the active version — `discard` only deletes a ref; `retry` only starts a fresh run from the already-restored last-good checkpoint (issue #142's explicit out-of-scope item).
- Full reference: `docs/superpowers/specs/2026-07-18-draft-branches-design.md`.

---

### Task 1: Contracts — persist `draftCommit`/discard audit fields, add request/response schemas

**Files:**

- Modify: `packages/contracts/src/run.ts:139-146` (`RunExecutionStateSchema.ceiling`)
- Modify: `packages/contracts/src/project.ts:75-113` (`ProjectEventSchema.type` enum)
- Modify: `packages/contracts/src/api.ts` (insert after line 218, the end of `CreateModelOverrideResponseSchema`)
- Test: `packages/contracts/src/run.test.ts` (extend the existing "parses restart-safe execution and emergency ceiling evidence" test area, ~line 174)
- Test: `packages/contracts/src/api.test.ts` (new `describe` block — check this file exists first with `ls packages/contracts/src/api.test.ts`; if it doesn't, add the block to `packages/contracts/src/run.test.ts` instead, next to the `WorkflowRunSchema` tests, to avoid creating a near-empty new file)

**Interfaces:**

- Produces: `RunExecutionState['ceiling']` now optionally carries `draftCommit: string`, `discardedAt: string` (ISO datetime), `discardedBy: ActorRef`.
- Produces: `ProjectEvent['type']` includes `'run.draft_discarded'`.
- Produces: `DraftDetailResponseSchema` (`{ draftBranch: string; diff: string }`), `DiscardDraftRequestSchema` (`{ actor: ActorRef; reason?: string }`), `DiscardDraftResponseSchema` (`{ run: WorkflowRun }`), `RetryProjectRequestSchema` (`{ prompt?: string; override?: Omit<CreateModelOverrideRequest, 'scope'> }`), all exported as both schema and inferred type — later tasks (3, 4, 5, 6) import these by name.

- [ ] **Step 1: Write the failing contract test for the new `ceiling` fields**

Add to `packages/contracts/src/run.test.ts`, right after the existing assertions in the `'parses restart-safe execution and emergency ceiling evidence'` test (after the line `expect(run.execution?.ceiling?.draftBranch).toBe('draft/run-1');`):

```ts
const discarded = WorkflowRunSchema.parse({
  ...run,
  execution: {
    ...run.execution,
    ceiling: {
      ...run.execution!.ceiling!,
      draftCommit: 'sha-0001',
      discardedAt: '2026-07-16T17:00:00.000Z',
      discardedBy: { kind: 'user', id: 'ed' },
    },
  },
});
expect(discarded.execution?.ceiling?.draftCommit).toBe('sha-0001');
expect(discarded.execution?.ceiling?.discardedBy).toEqual({ kind: 'user', id: 'ed' });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "emergency ceiling evidence"`
Expected: FAIL — `draftCommit`/`discardedAt`/`discardedBy` rejected by `.strict()` (zod "Unrecognized key(s)").

- [ ] **Step 3: Extend `RunExecutionStateSchema.ceiling`**

In `packages/contracts/src/run.ts`, replace:

```ts
    ceiling: z
      .object({
        reason: z.enum(['active-time', 'consecutive-repairs']),
        reachedAt: z.string().datetime(),
        draftBranch: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
```

with:

```ts
    ceiling: z
      .object({
        reason: z.enum(['active-time', 'consecutive-repairs']),
        reachedAt: z.string().datetime(),
        draftBranch: z.string().min(1).optional(),
        draftCommit: z.string().min(1).optional(),
        discardedAt: z.string().datetime().optional(),
        discardedBy: ActorRefSchema.optional(),
      })
      .strict()
      .optional(),
```

(`ActorRefSchema` is already imported at the top of `run.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "emergency ceiling evidence"`
Expected: PASS

- [ ] **Step 5: Add the `run.draft_discarded` event type**

In `packages/contracts/src/project.ts`, in the `ProjectEventSchema.type` enum, add `'run.draft_discarded'` right after `'run.emergency_ceiling_reached'`:

```ts
    'run.emergency_ceiling_reached',
    'run.draft_discarded',
```

No test needed for this alone (it's exercised end-to-end by Task 4's test); this is bundled into this task's commit.

- [ ] **Step 6: Write the failing test for the new request/response schemas**

Add a new `describe` block to `packages/contracts/src/run.test.ts` (append near the end of the file):

```ts
describe('draft inspection/discard/retry contracts', () => {
  it('parses a draft detail response', () => {
    const detail = DraftDetailResponseSchema.parse({
      draftBranch: 'draft/run-1',
      diff: '--- a/file\n+++ b/file\n',
    });
    expect(detail.draftBranch).toBe('draft/run-1');
  });

  it('requires an actor to discard a draft', () => {
    expect(() => DiscardDraftRequestSchema.parse({})).toThrow();
    const request = DiscardDraftRequestSchema.parse({
      actor: { kind: 'user', id: 'ed' },
      reason: 'no longer needed',
    });
    expect(request.actor.id).toBe('ed');
  });

  it('parses an optional prompt/override retry request', () => {
    expect(RetryProjectRequestSchema.parse({})).toEqual({});
    const request = RetryProjectRequestSchema.parse({
      prompt: 'Try a smaller migration this time.',
      override: {
        modelId: 'model-1',
        provider: 'claude',
        model: 'opus',
        actor: { kind: 'user', id: 'ed' },
        reason: 'faster model',
        estimatedImpact: 'lower latency',
      },
    });
    expect(request.override?.modelId).toBe('model-1');
  });
});
```

Add `DraftDetailResponseSchema, DiscardDraftRequestSchema, RetryProjectRequestSchema` to the existing `import { ... } from '@agent-foundry/contracts'` (or `'./run.js'`/local import, matching however this test file currently imports — check the top of `run.test.ts` for the existing import style before editing) at the top of the file.

- [ ] **Step 7: Run test to verify it fails**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "draft inspection"`
Expected: FAIL — `DraftDetailResponseSchema` etc. are not exported yet.

- [ ] **Step 8: Add the new schemas to `packages/contracts/src/api.ts`**

Insert immediately after `export type CreateModelOverrideResponse = z.infer<typeof CreateModelOverrideResponseSchema>;` (line 218):

```ts
export const DraftDetailResponseSchema = z
  .object({ draftBranch: z.string().min(1), diff: z.string() })
  .strict();
export type DraftDetailResponse = z.infer<typeof DraftDetailResponseSchema>;

export const DiscardDraftRequestSchema = z
  .object({ actor: ActorRefSchema, reason: z.string().trim().min(1).optional() })
  .strict();
export type DiscardDraftRequest = z.infer<typeof DiscardDraftRequestSchema>;

export const DiscardDraftResponseSchema = z.object({ run: WorkflowRunSchema }).strict();
export type DiscardDraftResponse = z.infer<typeof DiscardDraftResponseSchema>;

export const RetryProjectRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).optional(),
    override: CreateModelOverrideRequestSchema.omit({ scope: true }).optional(),
  })
  .strict();
export type RetryProjectRequest = z.infer<typeof RetryProjectRequestSchema>;
```

(`ActorRefSchema` and `WorkflowRunSchema` are already imported at the top of `api.ts`.)

- [ ] **Step 9: Run test to verify it passes**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "draft inspection"`
Expected: PASS

- [ ] **Step 10: Typecheck the contracts package**

Run: `npm run typecheck --workspace @agent-foundry/contracts`
Expected: no errors

- [ ] **Step 11: Commit**

```bash
git add packages/contracts/src/run.ts packages/contracts/src/project.ts packages/contracts/src/api.ts packages/contracts/src/run.test.ts
git commit -m "feat(contracts): add draft discard/retry fields and request schemas"
```

---

### Task 2: Orchestrator — persist `draftCommit` when a draft is preserved

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts:507-516`
- Test: `packages/orchestrator/src/emergency-ceiling.test.ts` (extend the first test, `'preserves a draft, restores the verified head, and finalizes the run once'`, ~line 126)

**Interfaces:**

- Consumes: `WorkspaceManager.preserveDraft` (unchanged signature, already returns `{ draftBranch, draftCommit, created }` — `packages/domain/src/ports.ts:396`).
- Produces: `run.execution.ceiling.draftCommit` is now populated whenever `run.execution.ceiling.draftBranch` is (same lifecycle) — Task 4's `discardDraft` relies on this value being present.

- [ ] **Step 1: Write the failing assertion**

In `packages/orchestrator/src/emergency-ceiling.test.ts`, in the first test (`'preserves a draft, restores the verified head, and finalizes the run once'`), change the existing assertion block:

```ts
expect(run).toMatchObject({
  status: 'failed',
  error: { name: 'EmergencyCeilingError', code: 'EMERGENCY_CEILING' },
  execution: {
    lastVerifiedCheckpoint: 'initial-head',
    ceiling: { draftBranch: 'draft/run-1' },
  },
});
```

to:

```ts
expect(run).toMatchObject({
  status: 'failed',
  error: { name: 'EmergencyCeilingError', code: 'EMERGENCY_CEILING' },
  execution: {
    lastVerifiedCheckpoint: 'initial-head',
    ceiling: { draftBranch: 'draft/run-1', draftCommit: expect.any(String) },
  },
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "preserves a draft"`
Expected: FAIL — `ceiling.draftCommit` is `undefined`.

- [ ] **Step 3: Persist `draftCommit` in `finalizeEmergencyCeiling`**

In `packages/orchestrator/src/workflow-orchestrator.ts`, inside `finalizeEmergencyCeiling`, change:

```ts
    if (!ceiling.draftBranch) {
      const draft = await this.workspaces.preserveDraft(projectId, runId, verifiedCheckpoint);
      const { draftBranch } = draft;
      run = await this.requireRun(runId);
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        if (draft.created) {
          await this.workspaces.discardDraft(projectId, runId, draft.draftCommit);
        }
        await this.finalizeCancellation(runId, projectId);
        return false;
      }
      try {
        run = await this.updateExecution(runId, (latest) => {
          if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
            throw new RunCancelledError(runId);
          }
          return {
            ...(latest.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
            ceiling: { ...latest.execution!.ceiling!, draftBranch },
          };
        });
```

to (only the destructure and the returned object literal change — do not alter the cancellation branch below it):

```ts
    if (!ceiling.draftBranch) {
      const draft = await this.workspaces.preserveDraft(projectId, runId, verifiedCheckpoint);
      const { draftBranch, draftCommit } = draft;
      run = await this.requireRun(runId);
      if (run.status === 'cancel_requested' || run.status === 'cancelled') {
        if (draft.created) {
          await this.workspaces.discardDraft(projectId, runId, draft.draftCommit);
        }
        await this.finalizeCancellation(runId, projectId);
        return false;
      }
      try {
        run = await this.updateExecution(runId, (latest) => {
          if (latest.status === 'cancel_requested' || latest.status === 'cancelled') {
            throw new RunCancelledError(runId);
          }
          return {
            ...(latest.execution ?? { activeElapsedMs: 0, consecutiveRepairs: 0 }),
            ceiling: { ...latest.execution!.ceiling!, draftBranch, draftCommit },
          };
        });
```

(Confirmed against the current file: `finalizeCancellation(runId, projectId)` — `runId` first. Only the destructure and the ceiling object literal change; the cancellation branch itself is untouched.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "preserves a draft"`
Expected: PASS

- [ ] **Step 5: Run the full emergency-ceiling suite (regression check)**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts`
Expected: all (now 25) tests PASS — the other 24 tests don't assert on `draftCommit`'s absence, so this is additive.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/emergency-ceiling.test.ts
git commit -m "feat(orchestrator): persist the draft branch's commit sha on the ceiling record"
```

---

### Task 3: Orchestrator — `ProjectService.getDraft` (diff inspection) + the "ceiling by time" acceptance test

**Files:**

- Modify: `packages/orchestrator/src/project-service.ts` (add method; add `getDraft` near `getRunDetail`, ~line 364-376)
- Test: `packages/orchestrator/src/emergency-ceiling.test.ts` (new test)

**Interfaces:**

- Consumes: `WorkspaceManager.diff(projectId, fromRef, toRef): Promise<string>` (existing, `packages/domain/src/ports.ts:405`); `run.execution.lastVerifiedCheckpoint`/`run.execution.ceiling.draftBranch` (existing fields).
- Produces: `ProjectService.getDraft(runId: string): Promise<{ draftBranch: string; diff: string }>` — Task 6 (API route) calls this directly.

- [ ] **Step 1: Write the failing acceptance test — "ceiling reached by time"**

Add to `packages/orchestrator/src/emergency-ceiling.test.ts` (new `describe` block at the end of the file, after the existing `describe('emergency ceiling accounting', ...)` block closes):

```ts
describe('draft inspection, retry, and discard', () => {
  it('demonstrates the ceiling reached by time and exposes the draft diff', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);
    stores.workspaces.touch();
    clock.advance(14_400_000);
    harness.executor.release('work');

    await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);
    const run = await stores.runs.get('run-1');
    expect(run?.execution?.ceiling?.reason).toBe('active-time');
    expect(run?.execution?.ceiling?.draftBranch).toBe('draft/run-1');

    const draft = await harness.service.getDraft('run-1');
    expect(draft.draftBranch).toBe('draft/run-1');
    expect(draft.diff).toBe('diff --fake initial-head..draft/run-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "ceiling reached by time"`
Expected: FAIL — `harness.service.getDraft` is not a function.

- [ ] **Step 3: Implement `ProjectService.getDraft`**

In `packages/orchestrator/src/project-service.ts`, add this method right after `getRunDetail` (after its closing `}` around line 376):

```ts
  /** The diff between the last verified checkpoint and a ceiling-preserved draft, for UI inspection. */
  async getDraft(runId: string): Promise<{ draftBranch: string; diff: string }> {
    const run = await this.requireRun(runId);
    const ceiling = run.execution?.ceiling;
    const verifiedCheckpoint = run.execution?.lastVerifiedCheckpoint;
    if (!ceiling?.draftBranch || !verifiedCheckpoint) {
      throw new NotFoundError(`Run ${runId} has no preserved draft`);
    }
    const diff = await this.workspaces.diff(run.projectId, verifiedCheckpoint, ceiling.draftBranch);
    return { draftBranch: ceiling.draftBranch, diff };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "ceiling reached by time"`
Expected: PASS

- [ ] **Step 5: Write and run a failing/passing test for the not-found case**

Add:

```ts
it('rejects inspecting a draft for a run that never reached a ceiling', async () => {
  const harness = makeHarness({ work: 'instant' }, undefined, { workflow: ONE_AGENT });
  await seedRun(harness);
  await harness.orchestrator.runProject('project-1', undefined, 'run-1');
  await expect(harness.service.getDraft('run-1')).rejects.toThrow('has no preserved draft');
});
```

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "rejects inspecting"`
Expected: PASS immediately (the implementation from Step 3 already handles this) — if it fails, the guard condition in Step 3 is wrong; fix before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/project-service.ts packages/orchestrator/src/emergency-ceiling.test.ts
git commit -m "feat(orchestrator): add ProjectService.getDraft for draft-diff inspection"
```

---

### Task 4: Orchestrator — `ProjectService.discardDraft` + the "ceiling by repair count" and "discard with confirmation" acceptance tests

**Files:**

- Modify: `packages/orchestrator/src/project-service.ts` (add method after `getDraft`)
- Test: `packages/orchestrator/src/emergency-ceiling.test.ts`

**Interfaces:**

- Consumes: `WorkspaceManager.discardDraft(projectId, runId, expectedCommit)` (existing); `ActorRef` (from `@agent-foundry/contracts`).
- Produces: `ProjectService.discardDraft(runId: string, input: { actor: ActorRef; reason?: string }): Promise<WorkflowRun>` — idempotent (a second call on an already-discarded draft returns the run unchanged and appends no duplicate event), matching the `cancelRun`/`pauseRun` idempotency convention already in this file.

- [ ] **Step 1: Write the failing acceptance test — "ceiling reached by repair count" + discard**

Add to the `describe('draft inspection, retry, and discard', ...)` block:

```ts
it('demonstrates the ceiling reached by consecutive repairs, then discards the draft only with an actor, recording an audit event', async () => {
  const harness = makeHarness({}, undefined, { workflow: QUALITY_LOOP });
  await seedRun(harness);

  await expect(
    harness.orchestrator.runProject('project-1', undefined, 'run-1'),
  ).rejects.toMatchObject({ name: 'EmergencyCeilingError', reason: 'consecutive-repairs' });

  const run = await harness.runs.get('run-1');
  expect(run?.execution?.ceiling?.reason).toBe('consecutive-repairs');
  const draftBranch = run!.execution!.ceiling!.draftBranch!;
  expect(harness.workspaces.drafts).toContain(draftBranch);

  const discarded = await harness.service.discardDraft('run-1', {
    actor: { kind: 'user', id: 'ed' },
    reason: 'bad attempt, starting over',
  });
  expect(discarded.execution?.ceiling?.discardedBy).toEqual({ kind: 'user', id: 'ed' });
  expect(harness.workspaces.drafts).not.toContain(draftBranch);
  const auditEvents = harness.events.types().filter((type) => type === 'run.draft_discarded');
  expect(auditEvents).toHaveLength(1);

  // Idempotent: discarding again is a no-op, not a duplicate audit entry.
  await harness.service.discardDraft('run-1', { actor: { kind: 'user', id: 'ed' } });
  expect(harness.events.types().filter((type) => type === 'run.draft_discarded')).toHaveLength(1);
});
```

This reuses the exact same drive sequence as the existing, already-passing `'ceilings on the tenth consecutive completed repair'` test a few dozen lines above in this same file (`makeHarness({}, undefined, { workflow: QUALITY_LOOP })` naturally loops the default quality-loop fixture through 10 repairs and ceilings, with no custom `agentOutput`/approval wiring needed) — `harness.workspaces`/`harness.events`/`harness.runs` are the same `Stores` fields spread onto the harness object (see `makeHarness`'s `return { ...stores, ... }`), so they're available directly without threading a separate `stores` variable through.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "ceiling reached by consecutive repairs"`
Expected: FAIL — `harness.service.discardDraft` is not a function.

- [ ] **Step 3: Implement `ProjectService.discardDraft`**

In `packages/orchestrator/src/project-service.ts`, add after `getDraft`:

```ts
  /**
   * Deletes a preserved draft's git branch and records who did it and when,
   * as a `run.draft_discarded` ProjectEvent — the durable audit trail this
   * codebase already uses for approval decisions and ceiling events.
   * Idempotent: discarding an already-discarded draft is a no-op.
   */
  async discardDraft(
    runId: string,
    input: { actor: ActorRef; reason?: string },
  ): Promise<WorkflowRun> {
    const run = await this.requireRun(runId);
    const ceiling = run.execution?.ceiling;
    if (!ceiling?.draftBranch || !ceiling.draftCommit) {
      throw new NotFoundError(`Run ${runId} has no preserved draft`);
    }
    if (ceiling.discardedAt) return run;

    await this.workspaces.discardDraft(run.projectId, runId, ceiling.draftCommit);
    const now = this.clock.now().toISOString();
    const updated = await this.runs.update(
      {
        ...run,
        execution: {
          ...run.execution!,
          ceiling: { ...ceiling, discardedAt: now, discardedBy: input.actor },
        },
        updatedAt: now,
      },
      run.version,
    );
    await this.appendEvent(
      run.projectId,
      'run.draft_discarded',
      `Draft ${ceiling.draftBranch} discarded by ${input.actor.displayName ?? input.actor.id}.`,
      runId,
      {
        draftBranch: ceiling.draftBranch,
        discardedBy: input.actor,
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
    return updated;
  }
```

Add `ActorRef` to the `import type { ... } from '@agent-foundry/contracts'` block at the top of `project-service.ts` if it isn't already there (check first — `ActorRef` may already be imported for `decideApproval`'s signature).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "ceiling reached by consecutive repairs"`
Expected: PASS

- [ ] **Step 5: Run the full orchestrator test suite (regression check)**

Run: `npx vitest run packages/orchestrator`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/project-service.ts packages/orchestrator/src/emergency-ceiling.test.ts
git commit -m "feat(orchestrator): add ProjectService.discardDraft with an audit event"
```

---

### Task 5: Orchestrator — extend `ProjectService.retry` with an optional prompt/model override + the "retry from a draft" acceptance test

**Files:**

- Modify: `packages/orchestrator/src/project-service.ts:235-273` (`retry` method)
- Test: `packages/orchestrator/src/emergency-ceiling.test.ts`
- Test-support: `packages/orchestrator/src/testing/harness.ts` (`FakeWorkspaces.writePrd`, currently a no-op — needs to record what it was called with so the test can assert on it)

**Interfaces:**

- Consumes: `ModelOverrideRepository.create` (existing); `WorkspaceManager.writePrd` (existing); `this.resolveCatalogModel`/`redactOverrideAudit` (existing private helpers already in this file, reused as-is).
- Produces: `ProjectService.retry(projectId: string, input?: { prompt?: string; override?: { modelId, provider, model, actor, reason, estimatedImpact } }): Promise<Project>` — backward compatible (`input` optional; omitting it reproduces today's exact behavior).

- [ ] **Step 1: Extend the fake `writePrd` to record calls (test support)**

In `packages/orchestrator/src/testing/harness.ts`, in `FakeWorkspaces`, change:

```ts
  writePrd(): Promise<void> {
    return Promise.resolve();
  }
```

to:

```ts
  lastPrd: string | undefined;
  writePrd(_projectId: string, prd: string): Promise<void> {
    this.lastPrd = prd;
    return Promise.resolve();
  }
```

This is test-support infrastructure, not itself a TDD step with its own red/green cycle — commit it together with Step 2's test.

- [ ] **Step 2: Write the failing acceptance test — "retry from a draft"**

Add to the `describe('draft inspection, retry, and discard', ...)` block:

```ts
it('retries from a draft with a new prompt and model override, leaving the draft branch untouched', async () => {
  const clock = new TestClock();
  const stores = makeStores(clock);
  const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
  await seedRun(harness);
  const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
  await waitUntil(() => harness.executor.started('work') === 1);
  stores.workspaces.touch();
  clock.advance(14_400_000);
  harness.executor.release('work');
  await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);

  const draftBranchBefore = [...stores.workspaces.drafts];
  const draftCommitBefore = new Map(stores.workspaces.draftCommits);

  const project = await harness.service.retry('project-1', {
    prompt: 'Try a smaller, incremental migration this time.',
    override: {
      modelId: 'model-1',
      provider: 'codex',
      model: 'test-model',
      actor: { kind: 'user', id: 'ed' },
      reason: 'known-good model for this task',
      estimatedImpact: 'higher success odds',
    },
  });

  expect(project.currentRunId).not.toBe('run-1');
  expect(stores.workspaces.lastPrd).toBe('Try a smaller, incremental migration this time.');
  const overrides = await stores.modelOverrides.list(project.currentRunId!);
  expect(overrides).toHaveLength(1);
  expect(overrides[0]?.scope).toEqual({ kind: 'run' });

  // The original draft is untouched: same branches, same commits.
  expect(stores.workspaces.drafts).toEqual(draftBranchBefore);
  expect(stores.workspaces.draftCommits).toEqual(draftCommitBefore);
});
```

Before finalizing, check `InMemoryModelOverrides`' exact method name for "list overrides for a run" in `packages/orchestrator/src/testing/harness.ts` (search `class InMemoryModelOverrides`) and use its real method name/signature — the sketch above assumes `.list(runId)`; confirm and adjust if the real fake uses a different name.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "retries from a draft"`
Expected: FAIL — `retry` doesn't accept a second argument yet. (`model-1`/`codex`/`test-model` is confirmed to already match `packages/orchestrator/src/testing/harness.ts`'s `MODELS` fixture exactly, so `resolveCatalogModel` will accept it once `retry` implements the override path.)

- [ ] **Step 4: Extend `ProjectService.retry`**

In `packages/orchestrator/src/project-service.ts`, replace the `retry` method:

```ts
  async retry(projectId: string): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running') return project;
    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;
    const saved = await this.projects.update(updated, project.version);
    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });
    await this.appendEvent(projectId, 'project.queued', 'Project manually re-queued.');
    return saved;
  }
```

with:

```ts
  async retry(
    projectId: string,
    input?: {
      prompt?: string;
      override?: {
        modelId: string;
        provider: Provider;
        model: string;
        actor: ActorRef;
        reason: string;
        estimatedImpact: string;
      };
    },
  ): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running') return project;
    if (input?.prompt) await this.workspaces.writePrd(projectId, input.prompt);
    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);
    // Created before the job is enqueued so the override is already visible
    // to the router by the time any worker could possibly claim the job —
    // no race window like there would be creating it after the fact.
    if (input?.override) {
      if (!this.modelOverrides) throw new Error('Model override repository is not configured');
      const match = await this.resolveCatalogModel(
        input.override.modelId,
        input.override.provider,
        input.override.model,
      );
      const audit = redactOverrideAudit(input.override);
      await this.modelOverrides.create({
        id: this.ids.next(),
        runId,
        scope: { kind: 'run' },
        modelId: match.id,
        provider: match.provider,
        model: match.model,
        ...audit,
        createdAt: now,
      });
    }
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;
    const saved = await this.projects.update(updated, project.version);
    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });
    await this.appendEvent(projectId, 'project.queued', 'Project manually re-queued.');
    return saved;
  }
```

`Provider`, `ActorRef` must be in this file's `import type { ... } from '@agent-foundry/contracts'` block — add them if missing.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "retries from a draft"`
Expected: PASS

- [ ] **Step 6: Run the full orchestrator test suite (regression check)**

Run: `npx vitest run packages/orchestrator`
Expected: all tests PASS (existing callers of `retry(projectId)` with no second argument must be unaffected — confirm by grepping `\.retry(` across `packages/orchestrator/src` and `apps/api/src` test files).

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/project-service.ts packages/orchestrator/src/testing/harness.ts packages/orchestrator/src/emergency-ceiling.test.ts
git commit -m "feat(orchestrator): retry can carry a new prompt or model override, without touching the draft"
```

---

### Task 6: API — routes for draft inspection, discard, and retry-with-input

**Files:**

- Modify: `apps/api/src/app.ts` (imports; three route handlers)
- Test: `apps/api/src/draft.test.ts` (new file, matching the fake-runtime pattern in `apps/api/src/project-versions.test.ts`)

**Interfaces:**

- Consumes: `runtime.projectService.getDraft`, `runtime.projectService.discardDraft`, `runtime.projectService.retry` (Tasks 3-5); `DiscardDraftRequestSchema`, `RetryProjectRequestSchema` (Task 1).
- Produces: `GET /runs/:runId/draft`, `POST /runs/:runId/draft/discard`, `POST /projects/:projectId/retry` (body now optional `RetryProjectRequestSchema`) — Task 7's web client calls these three routes by these exact paths/methods.

- [ ] **Step 1: Write the failing route tests**

Create `apps/api/src/draft.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import type { WorkflowRun } from '@agent-foundry/contracts';
import { NotFoundError } from '@agent-foundry/domain';
import { buildApp } from './app.js';

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    status: 'failed',
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

interface FakeProjectService {
  getDraft: ReturnType<typeof vi.fn>;
  discardDraft: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function buildFakeRuntime(overrides: Partial<FakeProjectService> = {}): {
  runtime: Runtime;
  projectService: FakeProjectService;
} {
  const projectService: FakeProjectService = {
    getDraft: vi.fn().mockResolvedValue({ draftBranch: 'draft/run-1', diff: '+x' }),
    discardDraft: vi.fn().mockResolvedValue(makeRun()),
    retry: vi.fn().mockResolvedValue({ id: 'project-1', currentRunId: 'run-2' }),
    ...overrides,
  };
  const runtime = {
    config: { webOrigin: 'http://localhost:3000' },
    projectService,
  } as unknown as Runtime;
  return { runtime, projectService };
}

describe('draft API', () => {
  it('returns a draft diff', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ draftBranch: 'draft/run-1', diff: '+x' });
    expect(projectService.getDraft).toHaveBeenCalledWith('run-1');
    await app.close();
  });

  it('404s when a run has no draft', async () => {
    const { runtime } = buildFakeRuntime({
      getDraft: vi.fn().mockRejectedValue(new NotFoundError('Run run-1 has no preserved draft')),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'GET', url: '/runs/run-1/draft' });

    expect(response.statusCode, response.body).toBe(404);
    await app.close();
  });

  it('discards a draft with an actor', async () => {
    const run = makeRun({
      execution: {
        activeElapsedMs: 0,
        consecutiveRepairs: 0,
        ceiling: {
          reason: 'active-time',
          reachedAt: new Date().toISOString(),
          draftBranch: 'draft/run-1',
          draftCommit: 'sha-1',
          discardedAt: new Date().toISOString(),
          discardedBy: { kind: 'user', id: 'ed' },
        },
      },
    });
    const { runtime, projectService } = buildFakeRuntime({
      discardDraft: vi.fn().mockResolvedValue(run),
    });
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-1/draft/discard',
      payload: { actor: { kind: 'user', id: 'ed' }, reason: 'not needed' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ run });
    expect(projectService.discardDraft).toHaveBeenCalledWith('run-1', {
      actor: { kind: 'user', id: 'ed' },
      reason: 'not needed',
    });
    await app.close();
  });

  it('rejects discarding a draft without an actor', async () => {
    const { runtime } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/runs/run-1/draft/discard',
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(400);
    await app.close();
  });

  it('retries a project with an optional prompt', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({
      method: 'POST',
      url: '/projects/project-1/retry',
      payload: { prompt: 'try again smaller' },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(projectService.retry).toHaveBeenCalledWith('project-1', { prompt: 'try again smaller' });
    await app.close();
  });

  it('retries a project with no body (back-compatible)', async () => {
    const { runtime, projectService } = buildFakeRuntime();
    const app = await buildApp(runtime);

    const response = await app.inject({ method: 'POST', url: '/projects/project-1/retry' });

    expect(response.statusCode, response.body).toBe(202);
    expect(projectService.retry).toHaveBeenCalledWith('project-1', {});
    await app.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/api/src/draft.test.ts`
Expected: FAIL — routes don't exist yet (404s where 200/202/400 expected).

- [ ] **Step 3: Add the routes**

In `apps/api/src/app.ts`, add `DiscardDraftRequestSchema, RetryProjectRequestSchema` to the existing `import { ... } from '@agent-foundry/contracts'` block. Then add, right after the existing `app.get('/runs/:runId/audit', ...)` block (~line 442-445):

```ts
app.get('/runs/:runId/draft', async (request) => {
  const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
  return runtime.projectService.getDraft(runId);
});

app.post('/runs/:runId/draft/discard', async (request, reply) => {
  const { runId } = z.object({ runId: PathSegmentSchema }).parse(request.params);
  const input = DiscardDraftRequestSchema.parse(request.body);
  const run = await runtime.projectService.discardDraft(runId, input);
  return reply.status(200).send({ run });
});
```

Then change the existing retry route (~line 456-460):

```ts
app.post('/projects/:projectId/retry', async (request, reply) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const project = await runtime.projectService.retry(projectId);
  return reply.status(202).send({ project });
});
```

to:

```ts
app.post('/projects/:projectId/retry', async (request, reply) => {
  const { projectId } = z.object({ projectId: PathSegmentSchema }).parse(request.params);
  const input = RetryProjectRequestSchema.parse(request.body ?? {});
  const project = await runtime.projectService.retry(projectId, input);
  return reply.status(202).send({ project });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/api/src/draft.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full API test suite (regression check)**

Run: `npx vitest run apps/api/src`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/draft.test.ts
git commit -m "feat(api): add draft inspect/discard routes and extend retry with prompt/override"
```

---

### Task 7: Web — API client functions

**Files:**

- Modify: `apps/web/lib/api.ts`
- Test: `apps/web/lib/api.test.ts`

**Interfaces:**

- Consumes: `GET /runs/:runId/draft`, `POST /runs/:runId/draft/discard`, `POST /projects/:projectId/retry` (Task 6).
- Produces: `getDraft(runId: string): Promise<DraftDetailResponse>`, `discardDraft(runId: string, input: DiscardDraftRequest): Promise<WorkflowRun>`, `retryProject(id: string, input?: RetryProjectRequest): Promise<Project>` — Task 8's UI calls these by these exact names.

- [ ] **Step 1: Write the failing client tests**

Add to `apps/web/lib/api.test.ts` (add `DiscardDraftRequest, DraftDetailResponse` to the existing `@agent-foundry/contracts` type import, and `discardDraft, getDraft, retryProject` to the existing `./api` import):

```ts
describe('draft API client', () => {
  it('fetches a draft diff', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ draftBranch: 'draft/run-1', diff: '+x' }));

    const result = await getDraft('run-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/runs/run-1/draft',
      expect.anything(),
    );
    expect(result).toEqual({ draftBranch: 'draft/run-1', diff: '+x' });
    fetchMock.mockRestore();
  });

  it('discards a draft with an actor', async () => {
    const run = { id: 'run-1' } as unknown as WorkflowRun;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ run }));

    const input: DiscardDraftRequest = { actor: { kind: 'user', id: 'ed' } };
    const result = await discardDraft('run-1', input);

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/runs/run-1/draft/discard', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
    });
    expect(result).toEqual(run);
    fetchMock.mockRestore();
  });

  it('retries a project with a prompt', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ project: { id: 'project-1' } }));

    await retryProject('project-1', { prompt: 'try smaller' });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/projects/project-1/retry', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'try smaller' }),
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
    });
    fetchMock.mockRestore();
  });
});
```

Check the exact request-building shape `api()` produces for a `POST` with a body (`apps/web/lib/api.ts`'s `api<T>` helper) before finalizing the `toHaveBeenCalledWith` object above — match it exactly rather than guessing the header set.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/lib/api.test.ts -t "draft API client"`
Expected: FAIL — `getDraft`/`discardDraft` don't exist; `retryProject` doesn't accept a second argument.

- [ ] **Step 3: Add the client functions**

In `apps/web/lib/api.ts`, add `DiscardDraftRequest, DraftDetailResponse, RetryProjectRequest` to the existing `@agent-foundry/contracts` type import. Change `retryProject`:

```ts
export async function retryProject(id: string): Promise<Project> {
  const response = await api<{ project: Project }>(`/projects/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
  });
  return response.project;
}
```

to:

```ts
export async function retryProject(id: string, input?: RetryProjectRequest): Promise<Project> {
  const response = await api<{ project: Project }>(`/projects/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
  return response.project;
}
```

Add, near `getRunDetail`:

```ts
export function getDraft(runId: string): Promise<DraftDetailResponse> {
  return api<DraftDetailResponse>(`/runs/${encodeURIComponent(runId)}/draft`);
}

export async function discardDraft(
  runId: string,
  input: DiscardDraftRequest,
): Promise<WorkflowRun> {
  const response = await api<{ run: WorkflowRun }>(
    `/runs/${encodeURIComponent(runId)}/draft/discard`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return response.run;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/web/lib/api.test.ts`
Expected: PASS (all tests in the file, not just the new ones — confirms the `retryProject` signature change didn't break its existing no-arg callers/tests)

- [ ] **Step 5: Typecheck the web app**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/api.ts apps/web/lib/api.test.ts
git commit -m "feat(web): add draft diff/discard API client functions"
```

---

### Task 8: Web — draft inspection/retry/discard panel on the project page

**Files:**

- Modify: `apps/web/lib/model-overrides.ts` (one new exported helper)
- Modify: `apps/web/app/project/[id]/page.tsx`

**Interfaces:**

- Consumes: `getDraft`, `discardDraft`, `retryProject` (Task 7); existing `DiffView`/`unifiedDiffToSpans` (same file, ~line 125-146); existing `ModelPinFields` component (same file, ~line 75-113); existing `pinFields(FormData)` helper (search for its existing usage in the model-override-panel form — reuse it, don't redefine it) and `runtimeModels`.
- Produces: `retryProjectOverride(models, fields): RetryProjectRequest['override']` in `apps/web/lib/model-overrides.ts` — a thin export reusing the same internal `pinRequest` validation `modelOverrideRequest`/`retryRequest` already use, just without the `scope` wrapper (`RetryProjectRequestSchema.override` has no `scope` field — retry always overrides the whole new run).

No automated test for this task — this repo has no `.tsx` test harness (verified: no RTL/jsdom component tests exist anywhere in `apps/web`, only pure-function tests in `apps/web/lib/*.test.ts` and `apps/web/app/project/[id]/format-usage.test.ts`, which tests a plain function, not a component). Verification for this task is manual/e2e (Task 9).

- [ ] **Step 0: Add `retryProjectOverride` to `apps/web/lib/model-overrides.ts`**

Add, right after the existing `retryRequest` function:

```ts
/** Same validated shape `modelOverrideRequest` builds, minus `scope` — a
 * project retry always overrides the whole new run, so there's no scope to
 * choose. */
export function retryProjectOverride(
  models: ModelDefinition[],
  fields: PinFields,
): {
  modelId: string;
  provider: CreateModelOverrideRequest['provider'];
  model: string;
  actor: ActorRef;
  reason: string;
  estimatedImpact: string;
} {
  return pinRequest(models, fields);
}
```

Since `pinRequest` is declared above this point in the same file and already returns exactly `{ modelId, provider, model, actor, reason, estimatedImpact }` (no `scope`), this is a direct reuse — no new validation logic.

- [ ] **Step 1: Add draft state**

Near the other `useState` declarations (e.g. next to `const [showDiff, setShowDiff] = useState(false);`), add:

```tsx
const [draftDiff, setDraftDiff] = useState<string | null>(null);
const [draftError, setDraftError] = useState('');
const [projectRetryWithPin, setProjectRetryWithPin] = useState(false);
```

- [ ] **Step 2: Add the fetch/discard/retry handlers**

Near the other handler functions (e.g. right after `async function retry() { ... }`), add:

```tsx
async function loadDraftDiff() {
  if (!run) return;
  try {
    const { diff } = await getDraft(run.id);
    setDraftDiff(diff);
    setDraftError('');
  } catch (cause) {
    setDraftError(cause instanceof Error ? cause.message : String(cause));
  }
}

async function discardCurrentDraft() {
  if (!run) return;
  const confirmed = window.confirm(
    'Discard this draft? The preserved branch will be deleted; this cannot be undone.',
  );
  if (!confirmed) return;
  try {
    await discardDraft(run.id, { actor: { kind: 'user', id: 'web-ui' } });
    setDraftDiff(null);
    setDraftError('');
    refresh();
  } catch (cause) {
    setDraftError(cause instanceof Error ? cause.message : String(cause));
  }
}

async function retryWithPrompt(prompt: string, override?: RetryProjectRequest['override']) {
  try {
    const input = {
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      ...(override ? { override } : {}),
    };
    await retryProject(id, Object.keys(input).length ? input : undefined);
    setResumeBlocked(null);
    refresh();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : String(cause));
  }
}
```

Add `RetryProjectRequest` to the existing `@agent-foundry/contracts` type import list.

Check the existing `refresh()`/`setResumeBlocked` functions' exact names in this file (both are already used by the existing `retry()`/`resume()` handlers a few lines above) before finalizing — reuse them as they already exist, don't redefine.

- [ ] **Step 3: Render the draft panel**

Inside the existing `{run && evidence ? (...)}` block (the "Limite de emergência e modelo fixado" panel), immediately after the closing `</dl>` and before the existing `<form onSubmit={(event) => void submitOverride(event)}>`, add:

```tsx
{
  evidence.draftBranch && !run.execution?.ceiling?.discardedAt ? (
    <div className="panel">
      <div className="panelHeader">
        <h2>Draft preservado</h2>
        <span className="hint">{evidence.draftBranch}</span>
      </div>
      {draftError ? <p className="errorBox">{draftError}</p> : null}
      <button type="button" className="secondaryButton" onClick={() => void loadDraftDiff()}>
        {draftDiff === null ? 'Ver diff' : 'Recarregar diff'}
      </button>
      {draftDiff !== null ? <DiffView parts={unifiedDiffToSpans(draftDiff)} /> : null}
      <button type="button" className="secondaryButton" onClick={() => void discardCurrentDraft()}>
        Descartar draft
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const prompt = data.get('retryPrompt');
          try {
            const override = projectRetryWithPin
              ? retryProjectOverride(runtimeModels, pinFields(data))
              : undefined;
            void retryWithPrompt(typeof prompt === 'string' ? prompt : '', override);
            event.currentTarget.reset();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      >
        <label>
          Novo prompt para a nova tentativa (opcional)
          <textarea name="retryPrompt" rows={3} />
        </label>
        <label>
          <input
            type="checkbox"
            checked={projectRetryWithPin}
            onChange={(event) => setProjectRetryWithPin(event.target.checked)}
          />{' '}
          Fixar um modelo para esta tentativa
        </label>
        {projectRetryWithPin ? <ModelPinFields models={runnableModels} /> : null}
        <button className="secondaryButton" type="submit">
          Tentar novamente a partir deste draft
        </button>
      </form>
    </div>
  ) : null;
}
```

Add `discardDraft, getDraft` to the existing `'../../../lib/api'` import list, `retryProjectOverride` to the existing `'../../../lib/model-overrides'` import list, and a new `const [projectRetryWithPin, setProjectRetryWithPin] = useState(false);` next to the Step 1 state declarations. `runnableModels` already exists in this file (it feeds the existing "Fixar modelo" panel's `ModelPinFields` a few lines below) — reuse it, don't recompute it.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace @agent-foundry/web`
Expected: no errors

- [ ] **Step 5: Build**

Run: `npm run build --workspace @agent-foundry/web`
Expected: build succeeds

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/project/\[id\]/page.tsx
git commit -m "feat(web): show draft diff, discard-with-confirmation, and retry-with-prompt on the project page"
```

---

### Task 9: Full verification pass

**Files:** none (verification only — no code changes expected; fix forward in the relevant task's files if something fails)

- [ ] **Step 1: Run the full repo check suite**

Run: `npm run check`
Expected: format, lint, architecture, roadmap, typecheck, test, and build all pass. If `roadmap:check` fails because it expects the roadmap spec's `v06-failed-drafts` entry to reference a closing PR, read the failure message and follow it — don't hand-edit `planning/roadmap-spec.json` speculatively (the file's header says a reconciler protects it by hash).

- [ ] **Step 2: Run the four required acceptance tests in isolation and capture their output verbatim**

```bash
npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "ceiling reached by time"
npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "consecutive repairs"
npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "retries from a draft"
npx vitest run packages/orchestrator/src/emergency-ceiling.test.ts -t "discard"
```

Save each command's real output — this is the evidence the PR description and the issue comment both require (Definition of Done: "demonstrated, not merely asserted").

- [ ] **Step 3: Manual smoke test of the web UI (if the sandbox allows starting long-running dev servers)**

Run: `EXECUTOR_MODE=mock RUN_WORKER_INLINE=true npm run smoke:mock` (API+worker in mock mode) alongside `npm run dev --workspace @agent-foundry/web`, create a project, and drive it (or a fixture project) into a ceiling state if the mock executor supports forcing one; otherwise, describe in the PR exactly which API responses (`GET /runs/:runId/draft`, `POST /runs/:runId/draft/discard`, `POST /projects/:projectId/retry`) were verified via `curl`/browser devtools against the running mock stack, since a full 4-hour/10-repair ceiling is impractical to trigger through the real UI in this environment.

- [ ] **Step 4: Update the issue with evidence (post-merge step, not a plan step)**

Not part of this plan's code — reserved for the PR/issue workflow after implementation.
