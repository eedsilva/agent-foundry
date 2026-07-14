import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';
import {
  ControllableExecutor,
  completeRun,
  FakeWorkspaces,
  invalidOutputError,
  liveStepRun,
  makeHarness,
  makeStores,
  rateLimitError,
  seedRun,
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
      {
        implement: { kind: 'fail-always', error: rateLimitError },
        review: { kind: 'fail-always', error: rateLimitError },
      },
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

describe('Group A: executor failure modes with fallback recovery', () => {
  it.each([
    ['timeout', timeoutError],
    ['rate limit', rateLimitError],
    ['invalid output', invalidOutputError],
  ])('recovers from %s via fallback with workspace restored', async (_label, error) => {
    const harness = makeHarness({ implement: { kind: 'fail-once', error } }, undefined, {
      fallback: true,
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    const implement = liveStepRun(harness, 'implement');
    const attempts = await harness.stepAttempts.list('run-1', implement.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);

    const failed = attempts[0]!;
    expect(failed.error).toBeDefined();
    expect(harness.artifacts.named(`run-${failed.id}-failure`)).toHaveLength(1);

    // The fallback restored the workspace to the checkpoint the first attempt
    // started from before the second attempt ran.
    expect(harness.workspaces.rollbacks).toContain(failed.checkpoint);
    // Only the successful attempt committed.
    expect(harness.workspaces.commits).toHaveLength(1);

    expect(harness.metricsRecords.filter((record) => !record.success)).toHaveLength(1);
    expect(harness.metricsRecords.some((record) => record.success)).toBe(true);
  });

  it('fails the run with a valid terminal state when all candidates fail', async () => {
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: rateLimitError } },
      undefined,
      { fallback: true },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    const implement = liveStepRun(harness, 'implement');
    expect(implement.status).toBe('failed');
    const attempts = await harness.stepAttempts.list('run-1', implement.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.status === 'failed')).toBe(true);
    expect(harness.workspaces.rollbacks.length).toBeGreaterThan(0);
    expect((await harness.projects.get('project-1'))?.status).toBe('failed');

    // Terminal-run guard: redelivering the failed run changes nothing.
    const before = {
      steps: harness.stepRuns.store.size,
      attempts: harness.stepAttempts.store.size,
      artifacts: harness.artifacts.artifacts.length,
      events: harness.events.events.length,
      commits: harness.workspaces.commits.length,
    };
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(harness.stepRuns.store.size).toBe(before.steps);
    expect(harness.stepAttempts.store.size).toBe(before.attempts);
    expect(harness.artifacts.artifacts.length).toBe(before.artifacts);
    expect(harness.events.events.length).toBe(before.events);
    expect(harness.workspaces.commits.length).toBe(before.commits);
  });
});
