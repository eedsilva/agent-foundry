import { describe, expect, it } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';
import {
  ControllableExecutor,
  FakeWorkspaces,
  invalidOutputError,
  makeStores,
  rateLimitError,
  timeoutError,
} from './testing/harness.js';

function request(stepId: string, mutatesWorkspace = false): AgentExecutionRequest {
  return {
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    projectId: 'project-1',
    stepId,
    role: 'developer',
    taskKind: 'implementation',
    provider: 'codex',
    model: 'test-model',
    prompt: 'do the thing',
    cwd: '/fake/project-1/workspace',
    mutatesWorkspace,
    timeoutMs: 60_000,
  };
}

describe('failure fixtures', () => {
  it('fail-once fails the first execution and succeeds on the second', async () => {
    const stores = makeStores();
    const executor = new ControllableExecutor(
      { implement: { kind: 'fail-once', error: rateLimitError } },
      stores.workspaces,
    );

    await expect(executor.execute(request('implement'))).rejects.toThrow(ExecutionError);
    const result = await executor.execute(request('implement'));
    expect(result.output.status).toBe('completed');
  });

  it('fail-always fails every execution', async () => {
    const stores = makeStores();
    const executor = new ControllableExecutor(
      { implement: { kind: 'fail-always', error: rateLimitError } },
      stores.workspaces,
    );

    await expect(executor.execute(request('implement'))).rejects.toThrow(ExecutionError);
    await expect(executor.execute(request('implement'))).rejects.toThrow(ExecutionError);
  });

  it('hang-until-abort rejects when the signal aborts', async () => {
    const stores = makeStores();
    const executor = new ControllableExecutor(
      { implement: { kind: 'hang-until-abort' } },
      stores.workspaces,
    );
    const controller = new AbortController();

    const running = executor.execute(request('implement'), controller.signal);
    controller.abort();

    await expect(running).rejects.toBe(controller.signal.reason);
  });

  it('error factories produce ExecutionError with the real-world shape', () => {
    expect(timeoutError()).toBeInstanceOf(ExecutionError);
    expect(rateLimitError().details.stderr).toContain('429');
    expect(invalidOutputError().message).toContain('valid artifact JSON');
  });

  it('dirties the workspace before failing a workspace-mutating step, but not a read-only one', async () => {
    const stores = makeStores();
    const executor = new ControllableExecutor(
      { implement: { kind: 'fail-always', error: rateLimitError }, review: { kind: 'fail-always', error: rateLimitError } },
      stores.workspaces,
    );

    await expect(executor.execute(request('implement', true))).rejects.toThrow(ExecutionError);
    expect(stores.workspaces.dirty).toBe(true);

    stores.workspaces.dirty = false;
    await expect(executor.execute(request('review', false))).rejects.toThrow(ExecutionError);
    expect(stores.workspaces.dirty).toBe(false);
  });
});

describe('FakeWorkspaces checkpoint/commit hooks', () => {
  it('invokes onBeforeCheckpoint and onAfterCheckpoint around checkpoint()', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const calls: string[] = [];
    workspaces.onBeforeCheckpoint = () => calls.push('before');
    workspaces.onAfterCheckpoint = () => calls.push('after');

    await workspaces.checkpoint();

    expect(calls).toEqual(['before', 'after']);
  });

  it('invokes onBeforeCommit before onAfterCommit, only when a commit actually happens', async () => {
    const workspaces = new FakeWorkspaces({ on: true });
    const calls: string[] = [];
    workspaces.onBeforeCommit = () => calls.push('before');
    workspaces.onAfterCommit = () => calls.push('after');

    // Not dirty: commit() is a no-op, neither hook fires.
    expect(await workspaces.commit()).toBeNull();
    expect(calls).toEqual([]);

    workspaces.touch();
    await workspaces.commit();
    expect(calls).toEqual(['before', 'after']);
  });
});
