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
    const plane = new ControllableExecutor(
      { implement: 'gated' },
      new FakeWorkspaces({ on: true }),
    );
    expect((await plane.status('attempt-1')).state).toBe('pending');
    const pending = plane.submit(request());
    expect((await plane.status('attempt-1')).state).toBe('running');
    plane.release('implement');
    const result = await pending;
    expect(result.state).toBe('completed');
    expect((await plane.status('attempt-1')).state).toBe('completed');
  });

  it('cancels an in-flight remote execution via an explicit cancel call, independent of any AbortSignal', async () => {
    const plane = new ControllableExecutor(
      { implement: 'gated' },
      new FakeWorkspaces({ on: true }),
    );
    const pending = plane.submit(request());
    await plane.cancel('attempt-1');
    const result = await pending;
    expect(result.state).toBe('cancelled');
    expect((await plane.status('attempt-1')).state).toBe('cancelled');
  });
});
