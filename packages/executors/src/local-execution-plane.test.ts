import { describe, expect, it } from 'vitest';
import {
  EXECUTION_PROTOCOL_VERSION,
  type ExecutionRequest,
  type ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import {
  EmergencyCeilingError,
  ExecutionError,
  ProviderAuthenticationError,
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

const completedArtifact = {
  schemaVersion: '1' as const,
  status: 'completed' as const,
  summary: 'done',
  data: {},
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};

function request(): ExecutionRequest {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: AGENT_REQUEST,
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    networkPolicy: { mode: 'none', allowedHosts: [], purpose: 'execution' },
    secrets: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeExecutor(behavior: 'succeed' | 'fail' | 'cancel' | 'ceiling'): AgentExecutor {
  return {
    provider: 'codex',
    async execute(agentRequest, _signal?) {
      if (behavior === 'cancel') throw new RunCancelledError(agentRequest.runId);
      if (behavior === 'ceiling')
        throw new EmergencyCeilingError(agentRequest.runId, 'active-time');
      if (behavior === 'fail') {
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
        output: completedArtifact,
      };
    },
    async health() {
      return { provider: 'codex', available: true, message: 'ok' };
    },
  };
}

function registryFor(executor: AgentExecutor): ExecutorRegistry {
  return { get: () => executor, health: () => Promise.resolve([]) };
}

describe('LocalExecutionPlane', () => {
  it('resolves cwd from the workspace snapshot and returns a completed result with no local path', async () => {
    let seenCwd: string | undefined;
    const baseExecutor = makeExecutor('succeed');
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async (agentRequest, signal?) => {
        seenCwd = agentRequest.cwd;
        return baseExecutor.execute(agentRequest, signal);
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
    const plane = new LocalExecutionPlane(registryFor(makeExecutor('fail')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    const result = await plane.submit(request());
    expect(result.state).toBe('failed');
    expect(result.error).toMatchObject({ exitCode: 1, stderr: '429 Too Many Requests' });
  });

  it("preserves auth failure kind when executor throws ProviderAuthenticationError", async () => {
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async () => {
        throw new ProviderAuthenticationError('Provider API key rejected', {
          stderr: '401 Unauthorized',
        });
      },
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    const result = await plane.submit(request());

    expect(result).toMatchObject({
      state: 'failed',
      error: {
        message: 'Provider API key rejected',
        stderr: '401 Unauthorized',
        kind: 'auth',
      },
    });
  });

  it('maps a RunCancelledError to a cancelled result', async () => {
    const plane = new LocalExecutionPlane(registryFor(makeExecutor('cancel')), {
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
    const plane = new LocalExecutionPlane(registryFor(makeExecutor('ceiling')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    await expect(plane.submit(request())).rejects.toBeInstanceOf(EmergencyCeilingError);
  });

  it('rejects malformed execution requests before invoking executor', async () => {
    let calls = 0;
    const baseExecutor = makeExecutor('succeed');
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async (agentRequest, signal?) => {
        calls += 1;
        return baseExecutor.execute(agentRequest, signal);
      },
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    await expect(
      plane.submit({ ...request(), protocolVersion: '2' } as unknown as ExecutionRequest),
    ).rejects.toThrow(/protocolVersion/i);
    expect(calls).toBe(0);
  });

  it('rejects malformed executor results at execution-plane boundary', async () => {
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async (agentRequest) =>
        ({
          runId: agentRequest.runId,
          stepRunId: agentRequest.stepRunId,
          attemptId: agentRequest.attemptId,
          provider: 'codex',
          model: agentRequest.model,
          exitCode: 0,
          durationMs: 5,
          stdout: 123,
          stderr: '',
          output: completedArtifact,
        }) as never,
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    await expect(plane.submit(request())).rejects.toThrow(/stdout/i);
  });

  it('reports pending, running, and completed status for local executions', async () => {
    const resultGate = deferred<Awaited<ReturnType<AgentExecutor['execute']>>>();
    const started = deferred<void>();
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async () => {
        started.resolve();
        return resultGate.promise;
      },
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    expect(await plane.status('unknown-execution')).toEqual({
      executionId: 'unknown-execution',
      state: 'pending',
    });

    const submitPromise = plane.submit(request());
    await started.promise;

    expect(await plane.status('attempt-1')).toEqual({
      executionId: 'attempt-1',
      state: 'running',
    });

    resultGate.resolve({
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      provider: 'codex',
      model: 'test-model',
      exitCode: 0,
      durationMs: 5,
      stdout: '{}',
      stderr: '',
      output: completedArtifact,
    });

    const result = await submitPromise;
    expect(await plane.status('attempt-1')).toEqual({
      executionId: 'attempt-1',
      state: 'completed',
      result,
    });
  });

  it('reports failed status after executor failure', async () => {
    const failingPlane = new LocalExecutionPlane(registryFor(makeExecutor('fail')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    const result = await failingPlane.submit(request());

    expect(await failingPlane.status('attempt-1')).toEqual({
      executionId: 'attempt-1',
      state: 'failed',
      result,
    });
  });

  it('supports explicit out-of-band cancel for in-flight local executions', async () => {
    const started = deferred<void>();
    const executor: AgentExecutor = {
      provider: 'codex',
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
      execute: async (agentRequest, signal) => {
        started.resolve();
        return await new Promise((resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason ?? new RunCancelledError(agentRequest.runId)),
            { once: true },
          );
        });
      },
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    const submitPromise = plane.submit(request());
    await started.promise;

    expect(await plane.status('attempt-1')).toEqual({
      executionId: 'attempt-1',
      state: 'running',
    });

    await plane.cancel('attempt-1');

    const result = await submitPromise;
    expect(result.state).toBe('cancelled');
    expect(await plane.status('attempt-1')).toEqual({
      executionId: 'attempt-1',
      state: 'cancelled',
      result,
    });
  });

  it('threads onEvent through to the executor', async () => {
    const events: unknown[] = [];
    const executor: AgentExecutor = {
      provider: 'codex',
      execute: async (
        agentRequest,
        _signal?: AbortSignal,
        onEvent?: (event: ExecutorStreamEvent) => void,
      ) => {
        onEvent?.({ type: 'status', phase: 'started' });
        return {
          runId: agentRequest.runId,
          stepRunId: agentRequest.stepRunId,
          attemptId: agentRequest.attemptId,
          provider: 'codex',
          model: agentRequest.model,
          exitCode: 0,
          durationMs: 1,
          stdout: '',
          stderr: '',
          output: completedArtifact,
        };
      },
      health: async () => ({ provider: 'codex', available: true, message: 'ok' }),
    };
    const plane = new LocalExecutionPlane(registryFor(executor), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });

    await plane.submit(request(), undefined, (event) => events.push(event));

    expect(events).toEqual([{ type: 'status', phase: 'started' }]);
  });
});
