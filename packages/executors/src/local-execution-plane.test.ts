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

  it('has no out-of-band cancel/status channel — local execution is synchronous', async () => {
    const plane = new LocalExecutionPlane(registryFor(makeExecutor('succeed')), {
      workspacePath: () => '/data/projects/project-1/workspace',
    });
    await expect(plane.status('attempt-1')).rejects.toThrow(/does not support/i);
  });
});
