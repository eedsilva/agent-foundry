# Chat Build ProjectVersion Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat-driven build operations record a `ProjectVersion` ledger entry (and stamp it on the `Operation`) exactly the same way workflow-run builds already do, restoring issue #40's invariant that every approved/executed mutating step produces exactly one ledgered commit.

**Architecture:** `ConversationOperationRunner` currently takes a raw `ProjectVersionRepository` and only ever calls `.list()` on it to build chat context — it never records anything after a commit. `WorkflowOrchestrator` already does this correctly: it takes an optional `ProjectVersionService` and, right after a mutating step's workspace commit, calls `versions.recordFromStep({ projectId, runId, stepRunId, attemptId, commit })`. The fix swaps `ConversationOperationRunner`'s dependency from `ProjectVersionRepository` to `ProjectVersionService` (which itself wraps a `ProjectVersionRepository` and already exposes a compatible `.list()`), calls `recordFromStep` at the same point `WorkflowOrchestrator` does, and stamps the resulting `ProjectVersion.id` onto `Operation.projectVersionId` so the chat UI can link an operation to its version without indirection through `runId`.

**Tech Stack:** TypeScript, vitest, existing `@agent-foundry/domain` / `@agent-foundry/orchestrator` / `@agent-foundry/contracts` packages (no new dependencies).

## Global Constraints

- Do not touch `WorkflowOrchestrator`'s existing (already-correct) recording path — this bug is isolated to the conversation/chat build path.
- Do not make `ProjectVersionService` optional on `ConversationOperationRunner` — the DI wiring in `packages/composition/src/runtime.ts` always constructs one; keeping the parameter required avoids adding a dead `if (this.versions)` branch that can never be false in production.
- Only record a version when the step actually mutated the workspace (`commit` is non-null) — mirror `WorkflowOrchestrator`'s `if (commit && this.versions)` guard (minus the now-always-true `this.versions` half).
- No new abstractions: reuse `ProjectVersionService.recordFromStep` as-is: `packages/orchestrator/src/project-version-service.ts:32`. Do not add a new method to that class.

---

## File Structure

- Modify: `packages/orchestrator/src/conversation-operation-runner.ts` — swap the `projectVersions: ProjectVersionRepository` constructor param for `projectVersions: ProjectVersionService`; call `recordFromStep` after a mutating commit; stamp `projectVersionId` onto the `Operation` in the same `updateOperation` call that already records `artifactReferences`.
- Modify: `packages/composition/src/runtime.ts` — pass the existing `projectVersionService` (already constructed at line ~172 for `WorkflowOrchestrator`) into `ConversationOperationRunner` instead of the raw `projectVersions` repository.
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts` — swap `MemoryProjectVersions` (a `ProjectVersionRepository` fake) for a `ProjectVersionService` built from it (real `ProjectVersionService` wired to `MemoryProjectVersions` + the test's existing `FakeWorkspaces`/`InMemoryArtifacts`/clock/ids — this is the same pattern `project-version-service.test.ts` already uses, so no new fake style); add a new test asserting a build operation records exactly one `ProjectVersion` and stamps `operation.projectVersionId`, and extend the existing plan-operation test to assert zero versions are recorded.
- Modify: `packages/orchestrator/src/plan-build-modes.test.ts` — swap its inline `ProjectVersionRepository` stub for an equivalent `ProjectVersionService` stub (same duck-typed style `workflow-orchestrator.test.ts` already uses at line ~182: `{ recordFromStep, list } as unknown as ProjectVersionService`) so the file still compiles against the new constructor signature. No behavioral assertions needed there — this test doesn't exercise version recording.

## Interfaces

- Consumes: `ProjectVersionService.recordFromStep(input: { projectId: string; runId: string; stepRunId: string; attemptId: string; commit: string }): Promise<ProjectVersion>` — already implemented, `packages/orchestrator/src/project-version-service.ts:32`.
- Consumes: `ProjectVersionService.list(projectId: string, limit?: number): Promise<ProjectVersion[]>` — already implemented, `packages/orchestrator/src/project-version-service.ts:43`. Drop-in replacement for the `ProjectVersionRepository.list` call `ConversationOperationRunner` currently makes.
- Produces: `Operation.projectVersionId` gets populated (was always `undefined` before this change) — consumed by `packages/contracts/src/api.ts:59`'s `CreateOperationRequestSchema` pick and available to any future UI code that reads `operation.projectVersionId` directly. `findDiffApprovalVersions` (`apps/web/lib/diff-approval.ts`) is unaffected by this change directly — it already matches by `ProjectVersion.runId === operation.runId`, and this fix is what makes that match start succeeding for chat builds (there was previously no `ProjectVersion` row to match at all).

---

### Task 1: Record a ProjectVersion (and stamp it on the Operation) for every mutating chat-build operation

**Files:**

- Modify: `packages/orchestrator/src/conversation-operation-runner.ts:23-30` (imports), `:42-56` (constructor), `:211-214` (commit site), `:242-244` (operation update site)
- Modify: `packages/composition/src/runtime.ts:254-269` (DI wiring)
- Modify: `packages/orchestrator/src/conversation-operation-runner.test.ts:1-157` (fixture setup), plus two test bodies
- Modify: `packages/orchestrator/src/plan-build-modes.test.ts:1-15` (imports), `:123-128` (fixture stub)
- Test: `packages/orchestrator/src/conversation-operation-runner.test.ts`

**Interfaces:**

- Consumes: `ProjectVersionService` class (constructor: `(versions: ProjectVersionRepository, workspaces: WorkspaceManager, artifacts: ArtifactStore, clock: Clock, ids: IdGenerator)`), exported from `@agent-foundry/orchestrator` (`packages/orchestrator/src/project-version-service.ts`).
- Produces: `ConversationOperationRunner`'s constructor 13th parameter is now `projectVersions: ProjectVersionService` (was `ProjectVersionRepository`). Any other file constructing `ConversationOperationRunner` directly must pass a `ProjectVersionService`-shaped value.

- [ ] **Step 1: Write the failing test for the build path**

Open `packages/orchestrator/src/conversation-operation-runner.test.ts`. Replace the `MemoryProjectVersions`-as-repository setup with a real `ProjectVersionService` wired to that same in-memory repository, so the test exercises the real recording logic end to end (not a mock of it).

First, add the import (alongside the existing `ConversationOperationRunner` import at line 35):

```typescript
import { ConversationOperationRunner } from './conversation-operation-runner.js';
import { ProjectVersionService } from './project-version-service.js';
```

Change the `setup()` function (lines 112–157) so it builds a `ProjectVersionService` and passes _that_ to the runner, while still returning the raw `projectVersions` repository fake so tests can inspect stored versions directly:

```typescript
function setup(harness: HarnessRepository = harnessRepo) {
  const runs = new InMemoryRuns({ on: true }) as unknown as WorkflowRunRepository;
  const stepRuns = new InMemoryStepRuns({ on: true }) as unknown as StepRunRepository;
  const stepAttempts = new InMemoryStepAttempts({ on: true }) as unknown as StepAttemptRepository;
  const artifacts = new InMemoryArtifacts({ on: true }) as unknown as ArtifactStore;
  const events = new InMemoryEvents({ on: true }) as unknown as EventStore;
  const stepEvents = new InMemoryStepEvents();
  const workspaces = new FakeWorkspaces({ on: true });
  const conversations = new MemoryConversations();
  const projectVersions = new MemoryProjectVersions();
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const projectVersionService = new ProjectVersionService(
    projectVersions,
    workspaces,
    artifacts,
    clock,
    ids,
  );
  const executor = new ControllableExecutor({}, workspaces);
  const executors: ExecutorRegistry = {
    get: () => new AgentExecutorFromExecutionPlane(executor),
    health: () => Promise.resolve([]),
  };
  const runner = new ConversationOperationRunner(
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    stepEvents,
    harness,
    router,
    metrics,
    executors,
    workspaces,
    conversations,
    projectVersionService,
    clock,
    ids,
    { agentTimeoutMs: 60_000 },
  );
  return {
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    stepEvents,
    workspaces,
    conversations,
    projectVersions,
    runner,
  };
}
```

Note: `setup()` previously created its own `FixedClock()`/`SequentialIds()` inline in the `ConversationOperationRunner(...)` call; hoist them to local `const clock`/`const ids` (as shown above) so `ProjectVersionService` and `ConversationOperationRunner` share the same instances.

No new import is needed for `WorkspaceManager` — `FakeWorkspaces` (`packages/orchestrator/src/testing/harness.ts:656`) already `implements WorkspaceManager` directly, so it can be passed to `ProjectVersionService`'s constructor with no cast.

Now replace the two existing tests (lines 206–246) with versions that also assert on `ProjectVersion` recording:

```typescript
describe('ConversationOperationRunner', () => {
  it('completes a plan operation without touching the workspace or recording a version', async () => {
    const { runs, artifacts, workspaces, conversations, projectVersions, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'plan');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toEqual([]);
    expect(workspaces.commits).toEqual([]);
    const artifact = await artifacts.getLatest('project-1', `operation-${operationId}`);
    expect(artifact).not.toBeNull();
    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([
      {
        name: artifact!.metadata.name,
        revision: artifact!.metadata.revision,
        sha256: artifact!.metadata.sha256,
      },
    ]);
    expect(operation?.projectVersionId).toBeUndefined();
    expect(await projectVersions.list('project-1')).toEqual([]);
  });

  it('completes a build operation, commits the touched workspace, and records exactly one ProjectVersion', async () => {
    const { runs, artifacts, workspaces, conversations, projectVersions, runner } = setup();
    const { runId, operationId } = await seed(conversations, runs, 'build');

    await runner.run('project-1', runId, operationId);

    expect((await runs.get(runId))?.status).toBe('completed');
    expect(workspaces.checkpoints).toHaveLength(1);
    expect(workspaces.commits).toHaveLength(1);
    const artifact = await artifacts.getLatest('project-1', `operation-${operationId}`);
    expect(artifact).not.toBeNull();

    const versions = await projectVersions.list('project-1');
    expect(versions).toHaveLength(1);
    const [version] = versions;
    expect(version).toMatchObject({
      projectId: 'project-1',
      runId,
      kind: 'run',
      commit: workspaces.commits[0],
    });

    const operation = await conversations.getOperation('project-1', operationId);
    expect(operation?.artifactReferences).toEqual([
      {
        name: artifact!.metadata.name,
        revision: artifact!.metadata.revision,
        sha256: artifact!.metadata.sha256,
      },
    ]);
    expect(operation?.projectVersionId).toBe(version!.id);
  });
});
```

Leave every other `describe`/`it` block in the file untouched.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts`
Expected: FAIL — either a TypeScript error (`ProjectVersionRepository` is not assignable to the still-unchanged `ConversationOperationRunner` constructor param, or vice versa once the test is updated but the source isn't yet), or an assertion failure (`expect(versions).toHaveLength(1)` receiving `[]`, `operation?.projectVersionId` being `undefined` instead of the version id). Either failure mode confirms the test is exercising the missing behavior.

- [ ] **Step 3: Update `ConversationOperationRunner` to depend on `ProjectVersionService` and record the ledger entry**

Open `packages/orchestrator/src/conversation-operation-runner.ts`.

Change the import block (currently lines 10–29) to import `ProjectVersionService` as a value import (it's a class, not just a type) instead of `ProjectVersionRepository` as a type-only import, and drop `ProjectVersionRepository` from the `@agent-foundry/domain` type-only import list:

```typescript
import {
  NotFoundError,
  errorMessage,
  transitionStepAttempt,
  transitionStepRun,
  transitionWorkflowRun,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepEventRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import { buildTaskProfile } from './task-profiler.js';
import { compileCliPrompt, compileRequestMarkdown } from './prompt-compiler.js';
import { CONVERSATION_WORKFLOW_ID, buildConversationStep } from './conversation-step-config.js';
import { compileContext } from './context-compiler.js';
import { artifactReference, persistStreamEvent, runError } from './workflow-orchestrator.js';
import { ProjectVersionService } from './project-version-service.js';
```

Change the constructor field type (currently `private readonly projectVersions: ProjectVersionRepository,` around line 54):

```typescript
    private readonly projectVersions: ProjectVersionService,
```

The existing `const versions = await this.projectVersions.list(projectId, 5);` call (around line 71) needs no change — `ProjectVersionService.list` has the identical signature.

Find the commit site (around line 211, inside the `try` block, right after the executor result comes back):

```typescript
const commit = step.mutatesWorkspace
  ? await this.workspaces.commit(projectId, `conversation(${kind}): ${step.title}`)
  : null;
```

Immediately after this line (and before `const executionRoute = ...`), record the version when a commit happened:

```typescript
const projectVersion = commit
  ? await this.projectVersions.recordFromStep({
      projectId,
      runId,
      stepRunId: stepRun.id,
      attemptId: attempt.id,
      commit,
    })
  : null;
```

Then find the `updateOperation` call that stamps `artifactReferences` after success (around line 242–245):

```typescript
await this.conversations.updateOperation({
  ...operation,
  artifactReferences: [artifactReference(artifact)],
});
```

Add `projectVersionId` to that same update, conditionally (only set the key when a version was actually recorded, matching how `checkpoint`/`commit` are conditionally spread elsewhere in this file):

```typescript
await this.conversations.updateOperation({
  ...operation,
  artifactReferences: [artifactReference(artifact)],
  ...(projectVersion ? { projectVersionId: projectVersion.id } : {}),
});
```

- [ ] **Step 4: Update the `packages/composition/src/runtime.ts` DI wiring**

Open `packages/composition/src/runtime.ts`. Find the `ConversationOperationRunner` construction (around line 254–269):

```typescript
const operationRunner = new ConversationOperationRunner(
  runs,
  stepRuns,
  stepAttempts,
  artifacts,
  events,
  stepEvents,
  harness,
  router,
  metrics,
  executors,
  workspaces,
  conversations,
  projectVersions,
  clock,
  ids,
  { agentTimeoutMs: config.agentTimeoutMs },
);
```

Change the `projectVersions` argument to `projectVersionService` (already constructed above, at line ~172, and already passed to `WorkflowOrchestrator` at line ~222):

```typescript
const operationRunner = new ConversationOperationRunner(
  runs,
  stepRuns,
  stepAttempts,
  artifacts,
  events,
  stepEvents,
  harness,
  router,
  metrics,
  executors,
  workspaces,
  conversations,
  projectVersionService,
  clock,
  ids,
  { agentTimeoutMs: config.agentTimeoutMs },
);
```

Do not remove the `projectVersions` local (the raw repository) — it's still used to construct `projectVersionService` itself.

- [ ] **Step 5: Fix `plan-build-modes.test.ts` so it still compiles**

Open `packages/orchestrator/src/plan-build-modes.test.ts`. Change the type-only import at the top (line ~12) from `type ProjectVersionRepository` to `type ProjectVersionService`, importing it from `./project-version-service.js`:

```typescript
import {
  type ArtifactStore,
  type Clock,
  type EventStore,
  type ExecutorRegistry,
  type HarnessRepository,
  type IdGenerator,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type StepAttemptRepository,
  type StepRunRepository,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { type ProjectVersionService } from './project-version-service.js';
```

Change the inline stub (around line 123–128) from a `ProjectVersionRepository` shape to a `ProjectVersionService` shape, keeping the existing "just needs a valid port" comment since the reasoning still holds:

```typescript
// This test doesn't exercise context compilation, just needs a valid port.
const projectVersions: ProjectVersionService = {
  list: () => Promise.resolve([]),
  recordFromStep: () => {
    throw new Error('not exercised in this test');
  },
} as unknown as ProjectVersionService;
```

Leave the rest of the file (including the `new ConversationOperationRunner(...)` call that already passes `projectVersions` positionally) unchanged — it now receives the right type.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/conversation-operation-runner.test.ts packages/orchestrator/src/plan-build-modes.test.ts`
Expected: PASS, all tests green including the two new/updated assertions.

- [ ] **Step 7: Run the full orchestrator and composition package suites**

Run: `npx vitest run packages/orchestrator packages/composition`
Expected: PASS — confirms no other test in either package constructs `ConversationOperationRunner` or depends on the old signature.

- [ ] **Step 8: Typecheck the whole repo**

Run: `npm run typecheck` (or `npx tsc -b` if that's the repo's typecheck script — check `package.json` `scripts.typecheck` first)
Expected: PASS, no type errors in `conversation-operation-runner.ts`, `runtime.ts`, or either test file.

- [ ] **Step 9: Commit**

```bash
git add packages/orchestrator/src/conversation-operation-runner.ts \
        packages/orchestrator/src/conversation-operation-runner.test.ts \
        packages/orchestrator/src/plan-build-modes.test.ts \
        packages/composition/src/runtime.ts
git commit -m "fix(orchestrator): record ProjectVersion for chat build operations

Chat-driven build operations committed the workspace but never called
ProjectVersionService.recordFromStep, so those commits never appeared
in the versions panel, compare/revert/branch, or findDiffApprovalVersions
— breaking #40's invariant that every approved Operation creates exactly
one ledgered commit. ConversationOperationRunner now takes the same
ProjectVersionService WorkflowOrchestrator already uses (instead of a raw
ProjectVersionRepository), records a version after every mutating commit,
and stamps Operation.projectVersionId with it.

Fixes #186"
```

---

## Self-Review Notes

- **Spec coverage:** Issue #186 names three symptoms (versions panel, compare/revert/branch, `findDiffApprovalVersions`) and two root-cause lines (`conversation-operation-runner.ts:201-214` missing the record call, `Operation.projectVersionId` never set). Task 1 addresses both root causes directly: the `recordFromStep` call restores the versions-panel/compare/revert/branch symptoms (they all read off `ProjectVersionRepository.list`/`.get`, which now has rows), and the `findDiffApprovalVersions` symptom is restored because that function matches on `ProjectVersion.runId === operation.runId`, which the new `recordFromStep` call populates correctly (it always passes the operation's own `runId`). The `projectVersionId` stamp is the second root cause, addressed directly in Step 3.
- **Placeholder scan:** No TBD/TODO markers; every step shows the literal code to write or the literal command to run.
- **Type consistency:** `ProjectVersionService.recordFromStep`'s input shape (`{ projectId, runId, stepRunId, attemptId, commit }`) matches exactly between the plan's Task 1 Step 3 code and the existing `RecordFromStepInput` interface at `packages/orchestrator/src/project-version-service.ts:11-17`. `ProjectVersion.id`/`.runId`/`.commit` field names match `packages/contracts/src/project-version.ts`. `Operation.projectVersionId` matches `packages/contracts/src/conversation.ts:119`.
