# Issue #45: Control/Execution Plane Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also use Ponytail Full and `karpathy-guidelines` throughout.

**Goal:** Introduce a versioned `ExecutionRequest`/`ExecutionResult` protocol and an `ExecutionPlane` port so the orchestrator submits agent CLI work through an explicit boundary instead of invoking `ExecutorRegistry`/`AgentExecutor` directly, closing issue [#45](https://github.com/eedsilva/agent-foundry/issues/45) (roadmap task `v07-control-execution-plane`).

**Architecture:** Add a small wire protocol in `packages/contracts` (workspace snapshot, tools, limits, network policy, secret refs in; final state, agent result, logs, usage out — never a local filesystem path). Add one new domain port, `ExecutionPlane` (`submit`/`cancel`/`status`), consumed by `WorkflowOrchestrator` at its single existing CLI call site. Ship exactly one production implementation, `LocalExecutionPlane` (in `packages/executors`), which wraps the existing `ExecutorRegistry`/`AgentExecutor` machinery unchanged — this stays the trusted, in-process, dev-only path. A remote/sandboxed implementation is explicitly out of scope; it lands with the dependent roadmap tasks `v07-sandbox-runner` and `v07-container-backend`. Prove the protocol's remote-shaped guarantees (disconnect, retry, explicit cancel, observe) with a fake `ExecutionPlane` test double, reusing the orchestrator's existing fallback-retry test infrastructure wherever possible instead of building parallel scaffolding.

**Tech Stack:** TypeScript, Zod, Vitest, existing `@agent-foundry/contracts` / `@agent-foundry/domain` / `@agent-foundry/executors` / `@agent-foundry/orchestrator` / `@agent-foundry/composition` workspaces.

## Global Constraints

- Work happens on the current branch `worktree-issue-45-execution-plane` in `/Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-45-execution-plane` (already created off `origin/main` via the native worktree tool). Never push directly to `main`.
- No new dependency, no new HTTP/RPC transport, no real sandbox/container runner. This issue defines and wires the protocol boundary only.
- `packages/orchestrator` may only depend on `@agent-foundry/contracts` and `@agent-foundry/domain` (enforced by `npm run architecture:check`) — the new `ExecutionPlane` port and its test doubles must not import `@agent-foundry/executors`.
- `ExecutionResult` (and everything nested in it) must never carry a local filesystem path. `ExecutionRequest.agent` is `AgentExecutionRequest` **minus** `cwd`; the concrete `ExecutionPlane` implementation resolves `cwd` itself from `workspace.projectId`.
- Preserve every existing orchestrator/composition/API behavior and test assertion exactly — this is an internal seam migration, not a behavior change. `ExecutorRegistry`, `AgentExecutor`, `BaseCliExecutor`, `StaticExecutorRegistry`, `MockExecutorRegistry`, and all provider executors are unmodified.
- `tools`, `networkPolicy`, and `secrets` on `ExecutionRequest` are shape-only for this issue (always empty/`none` defaults from the orchestrator) — real enforcement is the explicit scope of the later `v07-sandbox-runner`, `v07-network-policy`, and `v07-secret-broker` roadmap tasks. Mark this with a `ponytail:` comment at the call site.
- Every production change follows verified RED → GREEN → commit.

---

### Task 1: Versioned `ExecutionRequest`/`ExecutionResult` protocol

**Files:**

- Create: `packages/contracts/src/execution-plane.ts`
- Create: `packages/contracts/src/execution-plane.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produce `EXECUTION_PROTOCOL_VERSION = '1'`.
- Produce `ExecutionWorkspaceSnapshotSchema` → `{ projectId: string, ref: string }`.
- Produce `ExecutionLimitsSchema` → `{ timeoutMs: number }`.
- Produce `ExecutionNetworkPolicySchema` → `{ mode: 'none' | 'allowlist', allowedHosts: string[] }`.
- Produce `ExecutionSecretRefSchema` → `{ name: string, ref: string }`.
- Produce `ExecutionAgentRequestSchema` = `AgentExecutionRequestSchema.omit({ cwd: true })`.
- Produce `ExecutionRequestSchema` → `{ protocolVersion: '1', executionId: string, agent: ExecutionAgentRequest, workspace, tools: string[], limits, networkPolicy, secrets: ExecutionSecretRef[] }`.
- Produce `ExecutionStateSchema` = `'completed' | 'failed' | 'cancelled'`.
- Produce `ExecutionFailureSchema` → `{ message: string, exitCode?: number, stdout?: string, stderr?: string }` (no local paths — text only).
- Produce `ExecutionResultSchema` → `{ protocolVersion: '1', executionId: string, state, agent?: AgentExecutionResult, error?: ExecutionFailure }`, refined so `state === 'completed'` requires `agent` and `state === 'failed'` requires `error`.
- Export all schemas and inferred types (`ExecutionRequest`, `ExecutionResult`, `ExecutionState`, `ExecutionFailure`, `ExecutionAgentRequest`, `ExecutionWorkspaceSnapshot`, `ExecutionLimits`, `ExecutionNetworkPolicy`, `ExecutionSecretRef`).

- [ ] **Step 1: Write the failing schema test**

```typescript
// packages/contracts/src/execution-plane.test.ts
import { describe, expect, it } from 'vitest';
import {
  EXECUTION_PROTOCOL_VERSION,
  ExecutionAgentRequestSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
} from './index.js';

const AGENT_REQUEST = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'test-model',
  prompt: 'do the thing',
  mutatesWorkspace: true,
  timeoutMs: 60_000,
} as const;

const AGENT_RESULT = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  provider: 'codex',
  model: 'test-model',
  exitCode: 0,
  durationMs: 12,
  stdout: '{}',
  stderr: '',
  output: {
    schemaVersion: '1',
    status: 'completed',
    summary: 'done',
    data: {},
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  },
} as const;

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: AGENT_REQUEST,
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    networkPolicy: { mode: 'none', allowedHosts: [] },
    secrets: [],
    ...overrides,
  };
}

describe('ExecutionRequestSchema', () => {
  it('parses a fully populated request', () => {
    expect(ExecutionRequestSchema.parse(request())).toMatchObject({
      protocolVersion: '1',
      executionId: 'attempt-1',
    });
  });

  it('rejects an unknown protocol version', () => {
    expect(ExecutionRequestSchema.safeParse(request({ protocolVersion: '2' })).success).toBe(
      false,
    );
  });

  it('never carries a local cwd — the field does not exist on the embedded agent request', () => {
    const parsed = ExecutionAgentRequestSchema.parse({ ...AGENT_REQUEST, cwd: '/Users/x/project' });
    expect(parsed).not.toHaveProperty('cwd');
  });
});

describe('ExecutionResultSchema', () => {
  it('parses a completed result carrying the agent result, no local paths', () => {
    const parsed = ExecutionResultSchema.parse({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      executionId: 'attempt-1',
      state: 'completed',
      agent: AGENT_RESULT,
    });
    expect(parsed.state).toBe('completed');
    expect(JSON.stringify(parsed)).not.toContain('/Users/');
  });

  it('parses a cancelled result with neither agent nor error', () => {
    expect(
      ExecutionResultSchema.parse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'cancelled',
      }).state,
    ).toBe('cancelled');
  });

  it('rejects a completed result missing the agent result', () => {
    expect(
      ExecutionResultSchema.safeParse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'completed',
      }).success,
    ).toBe(false);
  });

  it('rejects a failed result missing the error detail', () => {
    expect(
      ExecutionResultSchema.safeParse({
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: 'attempt-1',
        state: 'failed',
      }).success,
    ).toBe(false);
  });

  it('carries stdout/stderr/exitCode on failure without any filesystem path', () => {
    const parsed = ExecutionResultSchema.parse({
      protocolVersion: EXECUTION_PROTOCOL_VERSION,
      executionId: 'attempt-1',
      state: 'failed',
      error: { message: 'CLI exited with a failure status', exitCode: 1, stdout: '', stderr: '429' },
    });
    expect(parsed.error?.exitCode).toBe(1);
  });
});
```

- [ ] **Step 2: Verify RED**

```bash
npm run test:unit -- packages/contracts/src/execution-plane.test.ts
```

Expected: FAIL — `./index.js` does not export `execution-plane` symbols yet.

- [ ] **Step 3: Implement the minimum contracts**

```typescript
// packages/contracts/src/execution-plane.ts
import { z } from 'zod';
import { AgentExecutionRequestSchema, AgentExecutionResultSchema } from './agent.js';

export const EXECUTION_PROTOCOL_VERSION = '1' as const;

export const ExecutionWorkspaceSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ExecutionWorkspaceSnapshot = z.infer<typeof ExecutionWorkspaceSnapshotSchema>;

export const ExecutionLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

export const ExecutionNetworkPolicySchema = z
  .object({
    mode: z.enum(['none', 'allowlist']),
    allowedHosts: z.array(z.string()).default([]),
  })
  .strict();
export type ExecutionNetworkPolicy = z.infer<typeof ExecutionNetworkPolicySchema>;

export const ExecutionSecretRefSchema = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ExecutionSecretRef = z.infer<typeof ExecutionSecretRefSchema>;

export const ExecutionAgentRequestSchema = AgentExecutionRequestSchema.omit({ cwd: true });
export type ExecutionAgentRequest = z.infer<typeof ExecutionAgentRequestSchema>;

export const ExecutionRequestSchema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    agent: ExecutionAgentRequestSchema,
    workspace: ExecutionWorkspaceSnapshotSchema,
    tools: z.array(z.string()).default([]),
    limits: ExecutionLimitsSchema,
    networkPolicy: ExecutionNetworkPolicySchema,
    secrets: z.array(ExecutionSecretRefSchema).default([]),
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionStateSchema = z.enum(['completed', 'failed', 'cancelled']);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const ExecutionFailureSchema = z
  .object({
    message: z.string().min(1),
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
  })
  .strict();
export type ExecutionFailure = z.infer<typeof ExecutionFailureSchema>;

export const ExecutionResultSchema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    state: ExecutionStateSchema,
    agent: AgentExecutionResultSchema.optional(),
    error: ExecutionFailureSchema.optional(),
  })
  .strict()
  .refine((value) => (value.state !== 'completed' ? true : value.agent !== undefined), {
    message: 'A completed ExecutionResult must include the agent result',
    path: ['agent'],
  })
  .refine((value) => (value.state !== 'failed' ? true : value.error !== undefined), {
    message: 'A failed ExecutionResult must include the error detail',
    path: ['error'],
  });
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
```

Add to `packages/contracts/src/index.ts`:

```typescript
export * from './execution-plane.js';
```

- [ ] **Step 4: Verify GREEN**

```bash
npm run test:unit -- packages/contracts/src/execution-plane.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/execution-plane.ts packages/contracts/src/execution-plane.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): define the versioned execution-plane protocol"
```

---

### Task 2: `ExecutionPlane` port and the local (dev-only) implementation

**Files:**

- Modify: `packages/domain/src/ports.ts`
- Create: `packages/executors/src/local-execution-plane.ts`
- Create: `packages/executors/src/local-execution-plane.test.ts`
- Modify: `packages/executors/src/index.ts`

**Interfaces:**

- Consumes: `ExecutionRequest`, `ExecutionResult` from Task 1; existing `ExecutorRegistry`, `AgentExecutor`, `WorkspaceManager` ports.
- Produces `ExecutionStatus` → `{ executionId: string, state: 'pending' | 'running' | ExecutionState, result?: ExecutionResult }`.
- Produces `ExecutionPlane` port → `{ submit(request, signal?): Promise<ExecutionResult>; cancel(executionId): Promise<void>; status(executionId): Promise<ExecutionStatus> }`.
- Produces `LocalExecutionPlane implements ExecutionPlane`, constructed with `(executors: ExecutorRegistry, workspaces: Pick<WorkspaceManager, 'workspacePath'>)`.

- [ ] **Step 1: Add the port (no test needed — a pure interface; verified by the implementation's tests and `typecheck`)**

In `packages/domain/src/ports.ts`, add near `AgentExecutor`/`ExecutorRegistry` (after the `ExecutorRegistry` interface):

```typescript
export interface ExecutionStatus {
  executionId: string;
  state: 'pending' | 'running' | ExecutionState;
  result?: ExecutionResult;
}

/**
 * Boundary between the control plane (orchestrator) and wherever agent CLIs
 * actually run. `submit` always resolves — even a failed or cancelled run is
 * a normal response, not a rejection; only a genuine transport failure (the
 * call itself never completed) should reject. `cancel`/`status` are the
 * explicit, out-of-band remote-observability surface: a real remote
 * implementation is expected to also wire the AbortSignal passed to `submit`
 * into its own transport-level cancel, so callers keep this single
 * call-and-await shape.
 */
export interface ExecutionPlane {
  submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<ExecutionStatus>;
}
```

Add `ExecutionRequest, ExecutionResult, ExecutionState,` to the existing `import type { ... } from '@agent-foundry/contracts';` block at the top of the file (alongside `ExecutorHealth`).

- [ ] **Step 2: Write the failing `LocalExecutionPlane` test**

```typescript
// packages/executors/src/local-execution-plane.test.ts
import { describe, expect, it } from 'vitest';
import { EXECUTION_PROTOCOL_VERSION, type ExecutionRequest } from '@agent-foundry/contracts';
import {
  EmergencyCeilingError,
  ExecutionError,
  RunCancelledError,
  type AgentExecutor,
  type ExecutorRegistry,
} from '@agent-foundry/domain';
import { LocalExecutionPlane } from './local-execution-plane.js';

const AGENT_REQUEST: ExecutionRequest['agent'] = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'test-model',
  prompt: 'do the thing',
  mutatesWorkspace: false,
  timeoutMs: 60_000,
};

function request(): ExecutionRequest {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: AGENT_REQUEST,
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    networkPolicy: { mode: 'none', allowedHosts: [] },
    secrets: [],
  };
}

class FakeAgentExecutor implements AgentExecutor {
  readonly provider = 'codex';
  constructor(private readonly behavior: 'succeed' | 'fail' | 'cancel' | 'ceiling') {}
  async execute(agentRequest: Parameters<AgentExecutor['execute']>[0]) {
    if (this.behavior === 'cancel') throw new RunCancelledError(agentRequest.runId);
    if (this.behavior === 'ceiling') throw new EmergencyCeilingError(agentRequest.runId, 'active-time');
    if (this.behavior === 'fail') {
      throw new ExecutionError('CLI exited with a failure status', {
        exitCode: 1,
        stdout: 'partial output',
        stderr: '429 Too Many Requests',
      });
    }
    return {
      runId: agentRequest.runId,
      stepRunId: agentRequest.stepRunId,
      attemptId: agentRequest.attemptId,
      provider: 'codex',
      model: agentRequest.model,
      exitCode: 0,
      durationMs: 5,
      stdout: '{}',
      stderr: '',
      output: {
        schemaVersion: '1' as const,
        status: 'completed' as const,
        summary: 'done',
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
    };
  }
  async health() {
    return { provider: 'codex', available: true, message: 'ok' };
  }
}

function registryFor(executor: AgentExecutor): ExecutorRegistry {
  return { get: () => executor, health: () => Promise.resolve([]) };
}

describe('LocalExecutionPlane', () => {
  it('resolves cwd from the workspace snapshot and returns a completed result with no local path', async () => {
    let seenCwd: string | undefined;
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async (agentRequest) => {
        seenCwd = agentRequest.cwd;
        return new FakeAgentExecutor('succeed').execute(agentRequest);
      },
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    const result = await plane.submit(request());
    expect(seenCwd).toBe('/data/projects/project-1/workspace');
    expect(result.state).toBe('completed');
    expect(JSON.stringify(result)).not.toContain('/data/projects');
  });

  it('maps an ExecutionError to a failed result carrying exitCode/stdout/stderr', async () => {
    const plane = new LocalExecutionPlane(registryFor(new FakeAgentExecutor('fail')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    const result = await plane.submit(request());
    expect(result.state).toBe('failed');
    expect(result.error).toMatchObject({ exitCode: 1, stderr: '429 Too Many Requests' });
  });

  it('maps a RunCancelledError to a cancelled result', async () => {
    const plane = new LocalExecutionPlane(registryFor(new FakeAgentExecutor('cancel')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    const result = await plane.submit(request());
    expect(result.state).toBe('cancelled');
  });

  it('propagates an EmergencyCeilingError as a rejection instead of a failed result', async () => {
    // A ceiling breach is an orchestrator-level circuit breaker, not a normal
    // CLI/domain failure — it must reach the orchestrator's own
    // `instanceof EmergencyCeilingError` handling unchanged, not get
    // flattened into `{ state: 'failed' }` and lose its class identity.
    const plane = new LocalExecutionPlane(registryFor(new FakeAgentExecutor('ceiling')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    await expect(plane.submit(request())).rejects.toBeInstanceOf(EmergencyCeilingError);
  });

  it('has no out-of-band cancel/status channel — local execution is synchronous', async () => {
    const plane = new LocalExecutionPlane(registryFor(new FakeAgentExecutor('succeed')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    await expect(plane.status('attempt-1')).rejects.toThrow(/does not support/i);
  });
});
```

- [ ] **Step 3: Verify RED**

```bash
npm run test:unit -- packages/executors/src/local-execution-plane.test.ts
```

Expected: FAIL — `./local-execution-plane.js` does not exist.

- [ ] **Step 4: Implement `LocalExecutionPlane`**

```typescript
// packages/executors/src/local-execution-plane.ts
import { EXECUTION_PROTOCOL_VERSION, type ExecutionRequest, type ExecutionResult } from '@agent-foundry/contracts';
import {
  EmergencyCeilingError,
  ExecutionError,
  RunCancelledError,
  errorMessage,
  type ExecutionPlane,
  type ExecutionStatus,
  type ExecutorRegistry,
  type WorkspaceManager,
} from '@agent-foundry/domain';

/**
 * Runs agent CLIs in-process, in the same environment as the control plane.
 * This is the trusted, local-development fallback the roadmap calls for
 * (`v07-control-execution-plane`) — production hosting needs a real remote
 * `ExecutionPlane`, which lands with the sandbox runner (`v07-sandbox-runner`).
 */
export class LocalExecutionPlane implements ExecutionPlane {
  constructor(
    private readonly executors: ExecutorRegistry,
    private readonly workspaces: Pick<WorkspaceManager, 'workspacePath'>,
  ) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const executor = this.executors.get(request.agent.provider);
    const cwd = this.workspaces.workspacePath(request.workspace.projectId);
    try {
      const result = await executor.execute({ ...request.agent, cwd }, signal);
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      // A ceiling breach is an orchestrator-level circuit breaker, not a
      // normal execution outcome — it must propagate as a rejection so the
      // orchestrator's own `instanceof EmergencyCeilingError` handling still
      // sees it, exactly as it does today via the aborted signal's `reason`.
      if (error instanceof EmergencyCeilingError) throw error;
      if (error instanceof RunCancelledError) {
        return {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          executionId: request.executionId,
          state: 'cancelled',
        };
      }
      const details = error instanceof ExecutionError ? error.details : {};
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'failed',
        error: {
          message: errorMessage(error),
          ...(details.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
          ...(details.stdout !== undefined ? { stdout: details.stdout } : {}),
          ...(details.stderr !== undefined ? { stderr: details.stderr } : {}),
        },
      };
    }
  }

  // ponytail: local dev execution is in-process and synchronous — the
  // AbortSignal passed to submit() already cancels it. Out-of-band
  // cancel/observe (e.g. reconciling after a control-plane restart) is
  // meaningful only for a real remote runner; it lands with v07-sandbox-runner.
  async cancel(): Promise<void> {
    throw new Error('LocalExecutionPlane does not support out-of-band cancel; use the AbortSignal passed to submit().');
  }

  async status(): Promise<ExecutionStatus> {
    throw new Error('LocalExecutionPlane does not support out-of-band status; local execution is synchronous.');
  }
}
```

Add to `packages/executors/src/index.ts`:

```typescript
export * from './local-execution-plane.js';
```

- [ ] **Step 5: Verify GREEN**

```bash
npm run test:unit -- packages/executors/src/local-execution-plane.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/ports.ts packages/executors/src/local-execution-plane.ts packages/executors/src/local-execution-plane.test.ts packages/executors/src/index.ts
git commit -m "feat(executors): add the local (dev-only) ExecutionPlane"
```

---

### Task 3: Migrate `WorkflowOrchestrator` to the `ExecutionPlane` port

This task is one atomic refactor: the constructor signature changes, so every construction site (production orchestrator, its two test-local fixtures, and the shared test harness) must move together or nothing compiles. Treat "RED" as "compile and existing suite fail because the type doesn't exist yet"; "GREEN" is the full orchestrator suite passing unchanged, plus the new execution-plane tests.

**Files:**

- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.test.ts`
- Modify: `packages/orchestrator/src/cancellation.test.ts`
- Modify: `packages/orchestrator/src/failure-injection.test.ts`
- Create: `packages/orchestrator/src/execution-plane.test.ts`

**Interfaces:**

- Consumes: `ExecutionPlane`, `ExecutionStatus` (Task 2, domain); `ExecutionRequest`, `ExecutionResult`, `EXECUTION_PROTOCOL_VERSION` (Task 1, contracts).
- Produces: `WorkflowOrchestrator`'s 14th constructor parameter renamed `executionPlane: ExecutionPlane` (was `executors: ExecutorRegistry`). `ControllableExecutor` (shared harness fixture) now `implements ExecutionPlane` directly with real `submit`/`cancel`/`status`.

- [ ] **Step 1: Rewrite `WorkflowOrchestrator`'s CLI call site**

In `packages/orchestrator/src/workflow-orchestrator.ts`, line 37, replace the import:

```typescript
  ExecutorRegistry,
```

with:

```typescript
  ExecutionPlane,
```

Add `EXECUTION_PROTOCOL_VERSION,` to the `@agent-foundry/contracts` value-import block (lines 26-30, alongside `AGENT_ARTIFACT_JSON_SCHEMA`).

Constructor (line 115): rename `private readonly executors: ExecutorRegistry,` to `private readonly executionPlane: ExecutionPlane,`.

At the `executeCandidate` call site (around line 1649), compute and pass the workspace ref (the existing `checkpoint` local is already in scope — it is `null` for non-mutating steps):

```typescript
        const workspaceRef = checkpoint ?? (await this.workspaces.head(project.id)) ?? runId;
        const result = await this.executeCandidate(
          project,
          step,
          runId,
          stepRun.id,
          attempt.id,
          candidate,
          signal,
          outputSchema,
          workspaceRef,
        );
```

Replace the whole `executeCandidate` method (lines 1862-1914) with:

```typescript
  private async executeCandidate(
    project: Project,
    step: AgentStep,
    runId: string,
    stepRunId: string,
    attemptId: string,
    candidate: RankedModel,
    signal: AbortSignal,
    outputSchema: AgentExecutionRequest['outputSchema'],
    workspaceRef: string,
  ): Promise<AgentExecutionResult> {
    await this.emit(project.id, 'agent.started', `${step.id} started on ${candidate.model.id}.`, {
      nodeId: step.id,
      runId,
      data: { modelId: candidate.model.id, provider: candidate.model.provider, attemptId },
    });
    const executionResult = await this.executionPlane.submit(
      {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: attemptId,
        agent: {
          runId,
          stepRunId,
          attemptId,
          projectId: project.id,
          stepId: step.id,
          role: step.role,
          taskKind: step.taskKind,
          provider: candidate.model.provider,
          model: candidate.model.model,
          prompt: compileCliPrompt(runId, stepRunId, attemptId),
          mutatesWorkspace: step.mutatesWorkspace,
          timeoutMs: this.options.agentTimeoutMs,
          outputSchema,
        },
        workspace: { projectId: project.id, ref: workspaceRef },
        // ponytail: tool allow-listing and network policy are shape-only until
        // v07-sandbox-runner/v07-network-policy/v07-secret-broker enforce them.
        tools: [],
        limits: { timeoutMs: this.options.agentTimeoutMs },
        networkPolicy: { mode: 'none', allowedHosts: [] },
        secrets: [],
      },
      signal,
    );
    // A result that arrives after cancellation was requested must never be promoted.
    throwIfCancelled(signal, runId);
    if (executionResult.state === 'cancelled') throw new RunCancelledError(runId);
    if (executionResult.state === 'failed' || !executionResult.agent) {
      const detail = executionResult.error;
      throw new ExecutionError(detail?.message ?? 'Execution plane reported a failure', {
        ...(detail?.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
        ...(detail?.stdout !== undefined ? { stdout: detail.stdout } : {}),
        ...(detail?.stderr !== undefined ? { stderr: detail.stderr } : {}),
      });
    }
    const result = executionResult.agent;
    await this.metrics.record({
      modelId: candidate.model.id,
      taskKind: step.taskKind,
      role: step.role,
      success: true,
      durationMs: result.durationMs,
      ...(result.usage?.inputTokens !== undefined ? { inputTokens: result.usage.inputTokens } : {}),
      ...(result.usage?.outputTokens !== undefined
        ? { outputTokens: result.usage.outputTokens }
        : {}),
      ...(result.usage?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: result.usage.estimatedCostUsd }
        : {}),
    });
    return result;
  }
```

- [ ] **Step 2: Migrate the shared test harness's `ControllableExecutor` to `ExecutionPlane`**

In `packages/orchestrator/src/testing/harness.ts`:

Replace `type AgentExecutor,` and `type ExecutorRegistry,` in the `@agent-foundry/domain` import block with `EmergencyCeilingError, RunCancelledError,` (value imports) and `type ExecutionPlane, type ExecutionStatus,` (type imports). Remove `type ExecutorHealth,` from the `@agent-foundry/contracts` import block (no longer used) and add `EXECUTION_PROTOCOL_VERSION, type ExecutionRequest, type ExecutionResult,`.

Replace the `ControllableExecutor` class (lines 669-755) with:

```typescript
export class ControllableExecutor implements ExecutionPlane {
  readonly startCounts = new Map<string, number>();
  private readonly gates = new Map<string, () => void>();
  private readonly states = new Map<string, ExecutionStatus['state']>();
  private readonly cancellers = new Map<string, () => void>();
  constructor(
    private readonly behaviors: Record<string, StepBehavior>,
    private readonly workspaces: FakeWorkspaces,
    private readonly output?: (
      request: AgentExecutionRequest,
    ) => AgentExecutionResult['output'] | undefined,
  ) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    this.states.set(request.executionId, 'running');
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancellers.set(request.executionId, () =>
        reject(new RunCancelledError(request.agent.runId)),
      );
    });
    try {
      const result = await Promise.race([
        this.executeInternal({ ...request.agent, cwd: 'unused' }, signal),
        cancelled,
      ]);
      this.states.set(request.executionId, 'completed');
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      // emergency-ceiling.test.ts's 'hang-until-abort' scenario rejects with
      // an EmergencyCeilingError via the aborted signal's `reason` — that must
      // keep propagating as a rejection, not collapse into a normal 'failed'
      // result, or the orchestrator's own `instanceof EmergencyCeilingError`
      // handling downstream would never see it.
      if (error instanceof EmergencyCeilingError) throw error;
      if (error instanceof RunCancelledError) {
        this.states.set(request.executionId, 'cancelled');
        return {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          executionId: request.executionId,
          state: 'cancelled',
        };
      }
      this.states.set(request.executionId, 'failed');
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'failed',
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    } finally {
      this.cancellers.delete(request.executionId);
    }
  }

  async cancel(executionId: string): Promise<void> {
    this.cancellers.get(executionId)?.();
  }

  async status(executionId: string): Promise<ExecutionStatus> {
    return { executionId, state: this.states.get(executionId) ?? 'pending' };
  }

  private executeInternal(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const count = (this.startCounts.get(request.stepId) ?? 0) + 1;
    this.startCounts.set(request.stepId, count);
    const behavior = this.behaviors[request.stepId] ?? 'instant';
    // Simulates a CLI that writes to the workspace before it reports success or failure.
    const touch = (): void => {
      if (request.mutatesWorkspace) this.workspaces.touch();
    };

    if (behavior === 'instant') {
      touch();
      return Promise.resolve(this.result(request));
    }
    if (behavior === 'gated') {
      return new Promise((resolve) => {
        this.gates.set(request.stepId, () => {
          touch();
          resolve(this.result(request));
        });
      });
    }
    if (behavior.kind === 'hang-until-abort') {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    const shouldFail = behavior.kind === 'fail-always' || count === 1;
    touch();
    if (shouldFail) return Promise.reject(behavior.error());
    return Promise.resolve(this.result(request));
  }

  release(stepId: string): void {
    const open = this.gates.get(stepId);
    if (!open) throw new Error(`no gated execution for ${stepId}`);
    this.gates.delete(stepId);
    open();
  }

  started(stepId: string): number {
    return this.startCounts.get(stepId) ?? 0;
  }

  private result(request: AgentExecutionRequest): AgentExecutionResult {
    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'codex',
      model: request.model,
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      output: this.output?.(request) ?? {
        schemaVersion: '1',
        status: 'completed',
        summary: `${request.stepId} done.`,
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
    };
  }
}
```

Note: `executeInternal` takes the full `AgentExecutionRequest` shape (it never reads `.cwd`, so the placeholder `'unused'` value passed from `submit` is inert — kept only so the existing method body needs zero changes beyond its name).

In `makeHarness()` (around line 815), remove the `const registry: ExecutorRegistry = { ... }` block (lines 932-935) entirely, and change the `new WorkflowOrchestrator(...)` call (line 968) from `registry,` to `executor,`.

Add one new fixture export for the disconnect scenario, near `invalidOutputError` (line 663):

```typescript
/** Simulates a transport-level failure between control plane and execution plane — not a CLI/domain error. */
export function disconnectError(): Error {
  return new Error('ECONNRESET: execution plane disconnected before the run completed');
}
```

- [ ] **Step 3: Migrate `workflow-orchestrator.test.ts`'s inline fixture**

In `packages/orchestrator/src/workflow-orchestrator.test.ts`, remove `type ExecutorRegistry,` from the `@agent-foundry/domain` import (line 9). In `makeOrchestrator()`, delete the `const registry: ExecutorRegistry = { ... }` block (lines 122-125) and change the `new WorkflowOrchestrator(...)` call (line 144) from `registry,` to `executor,`.

- [ ] **Step 4: Migrate `cancellation.test.ts`'s local fixture**

In `packages/orchestrator/src/cancellation.test.ts`: remove `type ExecutorHealth,` from the `@agent-foundry/contracts` import (line 13); remove `type AgentExecutor,` and `type ExecutorRegistry,` from the `@agent-foundry/domain` import (lines 29, 34) and add `type ExecutionPlane, type ExecutionStatus,` plus `EXECUTION_PROTOCOL_VERSION, type ExecutionRequest, type ExecutionResult,` (contracts).

Replace the local `ControllableExecutor` class (lines 416-472) with:

```typescript
class ControllableExecutor implements ExecutionPlane {
  readonly started = new Set<string>();
  readonly completed = new Set<string>();
  constructor(private readonly behaviors: Record<string, ExecutorBehavior>) {}

  async submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      const result = await this.executeInternal(request.agent, signal);
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'completed',
        agent: result,
      };
    } catch (error) {
      if (error instanceof RunCancelledError) {
        return {
          protocolVersion: EXECUTION_PROTOCOL_VERSION,
          executionId: request.executionId,
          state: 'cancelled',
        };
      }
      return {
        protocolVersion: EXECUTION_PROTOCOL_VERSION,
        executionId: request.executionId,
        state: 'failed',
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async cancel(): Promise<void> {}

  async status(executionId: string): Promise<ExecutionStatus> {
    return { executionId, state: this.completed.has(executionId) ? 'completed' : 'running' };
  }

  private executeInternal(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.started.add(request.stepId);
    const behavior = this.behaviors[request.stepId] ?? 'instant';
    if (behavior === 'instant') {
      this.completed.add(request.stepId);
      return Promise.resolve(this.result(request));
    }
    return new Promise((resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          if (behavior === 'resolve-on-abort') {
            this.completed.add(request.stepId);
            resolve(this.result(request));
          } else {
            reject(new RunCancelledError(request.runId));
          }
        },
        { once: true },
      );
    });
  }

  private result(request: AgentExecutionRequest): AgentExecutionResult {
    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'codex',
      model: request.model,
      exitCode: 0,
      durationMs: 1,
      stdout: '',
      stderr: '',
      output: {
        schemaVersion: '1',
        status: 'completed',
        summary: `${request.stepId} done.`,
        data: {},
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
    };
  }
}
```

Remove the local `const registry: ExecutorRegistry = { ... }` block (lines 552-555) and change the `new WorkflowOrchestrator(...)` call (line 578) from `registry,` to `executor,`.

- [ ] **Step 5: Add the disconnect+retry scenario to the existing fallback-recovery test**

In `packages/orchestrator/src/failure-injection.test.ts`, add `disconnectError` to the import from `./testing/harness.js`, and add one row to the existing `it.each` table (around line 106-113):

```typescript
  it.each([
    ['timeout', timeoutError],
    ['rate limit', rateLimitError],
    ['invalid output', invalidOutputError],
    ['disconnect', disconnectError],
  ])('recovers from %s via fallback with workspace restored', async (_label, error) => {
```

This proves disconnect + retry through the new `ExecutionPlane` boundary using the exact same fallback-recovery assertions already proven for the other three failure modes — no new test scaffolding needed.

- [ ] **Step 6: Add the explicit cancel/observe test for the fake remote runner**

```typescript
// packages/orchestrator/src/execution-plane.test.ts
import { describe, expect, it } from 'vitest';
import { EXECUTION_PROTOCOL_VERSION, type ExecutionRequest } from '@agent-foundry/contracts';
import { ControllableExecutor, FakeWorkspaces } from './testing/harness.js';

function request(): ExecutionRequest {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: {
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      projectId: 'project-1',
      stepId: 'implement',
      role: 'developer',
      taskKind: 'implementation',
      provider: 'codex',
      model: 'test-model',
      prompt: 'do the thing',
      mutatesWorkspace: false,
      timeoutMs: 60_000,
    },
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    networkPolicy: { mode: 'none', allowedHosts: [] },
    secrets: [],
  };
}

describe('ExecutionPlane: fake remote runner contract (disconnect/retry covered in failure-injection.test.ts)', () => {
  it('observes pending, running, and completed state across a submission', async () => {
    const plane = new ControllableExecutor({ implement: 'gated' }, new FakeWorkspaces());
    expect((await plane.status('attempt-1')).state).toBe('pending');
    const pending = plane.submit(request());
    expect((await plane.status('attempt-1')).state).toBe('running');
    plane.release('implement');
    const result = await pending;
    expect(result.state).toBe('completed');
    expect((await plane.status('attempt-1')).state).toBe('completed');
  });

  it('cancels an in-flight remote execution via an explicit cancel call, independent of any AbortSignal', async () => {
    const plane = new ControllableExecutor({ implement: 'gated' }, new FakeWorkspaces());
    const pending = plane.submit(request());
    await plane.cancel('attempt-1');
    const result = await pending;
    expect(result.state).toBe('cancelled');
    expect((await plane.status('attempt-1')).state).toBe('cancelled');
  });
});
```

- [ ] **Step 7: Verify GREEN**

```bash
npm run test:unit -- packages/orchestrator
npm run typecheck
npm run architecture:check
```

Expected: PASS — every existing orchestrator test still passes unchanged, plus the new disconnect row and the new cancel/observe test.

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator
git commit -m "refactor(orchestrator): submit agent work through the ExecutionPlane port"
```

---

### Task 4: Wire `LocalExecutionPlane` into the composition root

**Files:**

- Modify: `packages/composition/src/runtime.ts`

**Interfaces:**

- Consumes: `LocalExecutionPlane` (Task 2).
- Produces: `Runtime.executionPlane: LocalExecutionPlane` (new field; `Runtime.executors` is unchanged and keeps serving `GET /health`).

- [ ] **Step 1: Construct and wire the execution plane**

In `packages/composition/src/runtime.ts`, add `LocalExecutionPlane` to the `@agent-foundry/executors` import (line 1-11 block). Add `executionPlane: LocalExecutionPlane;` to the `Runtime` interface, next to `executors`. After the existing `executors` construction (line 115-122), add:

```typescript
  const executionPlane = new LocalExecutionPlane(executors, workspaces);
```

In the `new WorkflowOrchestrator(...)` call (line 178), change `executors,` to `executionPlane,`. Add `executionPlane,` to the object returned by `createRuntime` alongside `executors,`.

- [ ] **Step 2: Verify GREEN across the whole workspace**

```bash
npm run check
```

Expected: PASS (format, lint, architecture, roadmap checks, typecheck, full test suite, build).

- [ ] **Step 3: Commit**

```bash
git add packages/composition/src/runtime.ts
git commit -m "feat(composition): wire the local ExecutionPlane into the runtime"
```

---

### Task 5: ADR and operator documentation

**Files:**

- Create: `docs/adr/0023-control-execution-plane-protocol.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`

**Interfaces:**

- Document the protocol shape, the `ExecutionPlane` port, why `LocalExecutionPlane` stays dev-only/trusted, and the explicit deferral of real sandboxing/network policy/secret broker to `v07-sandbox-runner`, `v07-container-backend`, `v07-network-policy`, `v07-secret-broker`.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0023-control-execution-plane-protocol.md` following the existing ADR format (see `docs/adr/0014-project-policy-enforcement.md` for the section structure: Status/Date/Owners, Context, Decision, Alternatives considered, Consequences, Validation and rollback). Cover:
- Context: the orchestrator called `ExecutorRegistry`/`AgentExecutor` directly, spawning CLIs in the same process as the control plane (issue #45, roadmap task `v07-control-execution-plane`).
- Decision: the `ExecutionRequest`/`ExecutionResult` protocol (fields and why — workspace snapshot instead of `cwd`, tools/networkPolicy/secrets as shape-only placeholders, `state` machine, no local paths in the result), the `ExecutionPlane` port (`submit`/`cancel`/`status`), and `LocalExecutionPlane` as the sole, explicitly dev-only implementation.
- Alternatives considered: extending `AgentExecutionRequest`/`Result` in place (rejected — conflates the CLI-specific shape with the transport envelope a remote runner needs); building the real sandboxed runner now (rejected — out of scope, tracked by dependent roadmap tasks).
- Consequences: no behavior change for existing runs; `cancel`/`status` are unused by `LocalExecutionPlane` today and become load-bearing once a remote implementation exists; tool/network/secret enforcement is deferred.
- Validation and rollback: unit suites in contracts, executors, orchestrator (listed in Task 1-3) plus `npm run check`. Rollback: revert the change — no data migration, since `ExecutionRequest`/`ExecutionResult` are not persisted.

- [ ] **Step 2: Update ARCHITECTURE.md**

In `docs/ARCHITECTURE.md`, in the `packages/orchestrator` section (near the existing `BrowserVerificationCoordinator` paragraph, line ~89-91), add a short paragraph: the orchestrator submits agent work through the `ExecutionPlane` port (`submit`/`cancel`/`status`) instead of calling `ExecutorRegistry` directly; `LocalExecutionPlane` (in `packages/executors`) is the only implementation today and runs CLIs in-process, trusted-dev-only, same as before. Note that the sequence diagram's `E` (Executor) participant is now reached through this port.

- [ ] **Step 3: Update SECURITY.md**

In `docs/SECURITY.md`, near the existing paragraph about the worker running with host permissions (line ~39), add a sentence noting the new `ExecutionPlane` boundary exists specifically so a future remote/sandboxed runner can replace `LocalExecutionPlane` without changing the orchestrator, and that today nothing has changed about the trust boundary — CLIs still run with host permissions until `v07-sandbox-runner`/`v07-container-backend` land.

- [ ] **Step 4: Run the full gate**

```bash
npm run check
npm run doctor
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0023-control-execution-plane-protocol.md docs/ARCHITECTURE.md docs/SECURITY.md
git commit -m "docs: document the control/execution plane protocol (ADR 0023)"
```

---

## After the plan: PR and evidence

Not part of the coding tasks above, but required to close issue #45 per this repo's `docs/DEFINITION_OF_DONE.md`:

1. Push the branch and open a PR against `main` that links issue #45.
2. Run `superpowers:requesting-code-review` (or the `/code-review` and `/simplify` skills) against the diff; address findings; push updates.
3. Comment on issue #45 with evidence: the final `npm run check` output (or a summary), and a link to ADR 0023.
