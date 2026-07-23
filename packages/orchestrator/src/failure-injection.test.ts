import { describe, expect, it, vi } from 'vitest';
import { EXECUTION_PROTOCOL_VERSION, type ExecutionRequest } from '@agent-foundry/contracts';
import { ExecutionError } from '@agent-foundry/domain';
import {
  assertCountsUnchanged,
  ControllableExecutor,
  completeRun,
  disconnectError,
  FakeWorkspaces,
  invalidOutputError,
  liveStepRun,
  makeHarness,
  makeStores,
  rateLimitError,
  seedRun,
  snapshotCounts,
  timeoutError,
} from './testing/harness.js';

function request(stepId: string, mutatesWorkspace = false): ExecutionRequest {
  return {
    protocolVersion: EXECUTION_PROTOCOL_VERSION,
    executionId: 'attempt-1',
    agent: {
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
      mutatesWorkspace,
      timeoutMs: 60_000,
    },
    workspace: { projectId: 'project-1', ref: 'deadbeef' },
    tools: [],
    limits: { timeoutMs: 60_000 },
    networkPolicy: { mode: 'none', allowedHosts: [], purpose: 'execution' },
    secrets: [],
  };
}

describe('failure fixtures', () => {
  it('hang-until-abort resolves to a failed result when the signal aborts', async () => {
    const stores = makeStores();
    const executor = new ControllableExecutor(
      { implement: { kind: 'hang-until-abort' } },
      stores.workspaces,
    );
    const controller = new AbortController();

    const running = executor.submit(request('implement'), controller.signal);
    controller.abort();

    const result = await running;
    expect(result.state).toBe('failed');
    expect(result.error?.message).toBe(controller.signal.reason?.message);
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

    expect((await executor.submit(request('implement', true))).state).toBe('failed');
    expect(stores.workspaces.dirty).toBe(true);

    stores.workspaces.dirty = false;
    expect((await executor.submit(request('review', false))).state).toBe('failed');
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
  it('keys replay-adjacent agent and verification events by their persisted run records', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    for (const stepId of ['plan', 'implement', 'review']) {
      const stepRun = liveStepRun(harness, stepId);
      const [attempt] = await harness.stepAttempts.list('run-1', stepRun.id);
      const routed = harness.events.events.find(
        (event) => event.type === 'agent.routed' && event.nodeId === stepId,
      );
      const started = harness.events.events.find(
        (event) => event.type === 'agent.started' && event.data.attemptId === attempt?.id,
      );
      const completed = harness.events.events.find(
        (event) => event.type === 'agent.completed' && event.data.attemptId === attempt?.id,
      );

      expect(routed?.dedupeKey).toBe(`run-1:step:${stepRun.id}:routed`);
      expect(started?.dedupeKey).toBe(`run-1:attempt:${attempt?.id}:started`);
      expect(completed?.dedupeKey).toBe(`run-1:attempt:${attempt?.id}:completed`);
    }

    const verification = liveStepRun(harness, 'verify');
    const [verificationAttempt] = await harness.stepAttempts.list('run-1', verification.id);
    const completedVerification = harness.events.events.find(
      (event) => event.type === 'verification.completed',
    );
    expect(completedVerification?.dedupeKey).toBe(
      `run-1:attempt:${verificationAttempt?.id}:verification.completed`,
    );
  });

  it.each([
    ['timeout', timeoutError],
    ['rate limit', rateLimitError],
    ['invalid output', invalidOutputError],
    ['disconnect', disconnectError],
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
    expect(harness.events.events.find((event) => event.type === 'project.failed')?.dedupeKey).toBe(
      'run-1:project.failed',
    );

    // Terminal-run guard: redelivering the failed run changes nothing.
    const before = snapshotCounts(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    assertCountsUnchanged(harness, before);
  });
});

describe('Group B: process kill — a late result is never promoted', () => {
  it('never promotes a result that arrives after cancellation (process kill)', async () => {
    const harness = makeHarness({ implement: { kind: 'hang-until-abort' } });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('implement')).toBe(1);
    });
    await harness.service.cancelRun('run-1');
    await running; // cancellation is caught, not thrown

    expect((await harness.runs.get('run-1'))?.status).toBe('cancelled');
    const implement = liveStepRun(harness, 'implement');
    const attempts = await harness.stepAttempts.list('run-1', implement.id);
    expect(attempts[0]?.status).toBe('cancelled');
    // The killed step never committed and left no output artifact.
    expect(harness.workspaces.commits).toHaveLength(0);
    expect(harness.artifacts.named('implementation')).toHaveLength(0);
    // The workspace was rolled back to the checkpoint the attempt started from.
    expect(harness.workspaces.rollbacks).toContain(attempts[0]?.checkpoint);
  });
});

/**
 * Group C — phase crash matrix (PowerSwitch) + replay.
 *
 * | Phase boundary                            | Where covered                     |
 * | ----------------------------------------- | ---------------------------------- |
 * | before checkpoint                         | C1/C2 (this block, parameterized) |
 * | after checkpoint, before execution        | C1/C2 (this block, parameterized) |
 * | mid-execution (executor dies with power)  | C3 (this block)                   |
 * | after execution, before commit            | C4 (this block)                   |
 * | after commit, before artifact put         | run-controls.test.ts              |
 * | after artifact put, before attempt update | run-controls.test.ts              |
 * | before queue ack                          | run-controls.test.ts              |
 * | after ack (redelivery of completed run)   | C5 (this block)                   |
 *
 * Note: C1 and C2 assert the same persisted crash state (no attempt record
 * for the step) because the checkpoint ref is only persisted as a field on
 * the attempt record itself — there is no reachable "checkpoint persisted,
 * attempt not" state to distinguish them.
 */
describe('Group C: phase crash matrix + replay', () => {
  it.each([
    ['before checkpoint', 'onBeforeCheckpoint'],
    ['after checkpoint, before execution', 'onAfterCheckpoint'],
  ] as const)(
    'C1/C2: crash %s is resumable without duplicate side effects',
    async (_label, hook) => {
      const stores = makeStores();
      const first = makeHarness({}, stores);
      await seedRun(first);
      stores.workspaces[hook] = () => {
        stores.power.on = false;
      };

      await expect(first.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
        /simulated power loss/,
      );

      stores.workspaces[hook] = undefined;
      stores.power.on = true;
      const second = makeHarness({}, stores);
      await second.orchestrator.runProject('project-1', undefined, 'run-1');

      expect((await stores.runs.get('run-1'))?.status).toBe('completed');
      expect(second.executor.started('plan')).toBe(0); // completed plan reused
      expect(second.executor.started('implement')).toBe(1);
      expect(stores.artifacts.named('implementation')).toHaveLength(1);
      expect(stores.workspaces.commits).toHaveLength(1);
      // Lifecycle events stay single across the replay.
      expect(stores.events.types().filter((type) => type === 'project.started')).toHaveLength(1);
      expect(stores.events.types().filter((type) => type === 'node.started')).toHaveLength(4);
    },
  );

  it('C3: crash mid-execution finalizes the interrupted attempt and re-executes', async () => {
    const stores = makeStores();
    const first = makeHarness(
      {
        implement: {
          kind: 'fail-once',
          error: () => {
            stores.power.on = false;
            return new Error('simulated power loss');
          },
        },
      },
      stores,
    );
    await seedRun(first);

    await expect(first.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /simulated power loss/,
    );

    // The crash aborted the failed-transition write too, so the attempt is
    // left dangling in 'running'.
    const crashed = first.stepRuns.byStepId('run-1', 'implement')[0]!;
    const crashedAttempts = await stores.stepAttempts.list('run-1', crashed.id);
    expect(crashedAttempts[0]?.status).toBe('running');

    stores.power.on = true;
    const second = makeHarness({}, stores);
    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    // The dangling attempt and step are finalized as failed-interrupted.
    const finalized = await stores.stepAttempts.list('run-1', crashed.id);
    expect(finalized[0]?.status).toBe('failed');
    expect(finalized[0]?.error?.message).toMatch(/Interrupted/);
    const stepRuns = stores.stepRuns.byStepId('run-1', 'implement');
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]?.status).toBe('failed');
    expect(stepRuns[1]?.status).toBe('completed');
    expect(second.executor.started('implement')).toBe(1);
    expect(stores.artifacts.named('implementation')).toHaveLength(1);
    expect(stores.workspaces.commits).toHaveLength(1);
  });

  it('C4: crash after execution but before commit adopts the artifact and creates one commit', async () => {
    const stores = makeStores();
    const first = makeHarness({ implement: 'gated' }, stores);
    await seedRun(first);
    stores.workspaces.onBeforeCommit = () => {
      stores.power.on = false;
    };

    const running = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(first.executor.started('implement')).toBe(1);
    });
    // The executor succeeds; onBeforeCommit flips power off before the commit lands.
    first.executor.release('implement');
    await expect(running).rejects.toThrow(/simulated power loss/);
    expect(stores.workspaces.commits).toHaveLength(0);

    stores.workspaces.onBeforeCommit = undefined;
    stores.power.on = true;
    const second = makeHarness({}, stores);
    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(second.executor.started('implement')).toBe(0); // orphan artifact adopted
    expect(stores.artifacts.named('implementation')).toHaveLength(1);
    expect(stores.workspaces.commits).toHaveLength(1); // exactly one commit
  });

  it('C5: redelivery of a completed run after ack is a no-op on a fresh worker', async () => {
    const stores = makeStores();
    const first = makeHarness({}, stores);
    await completeRun(first);

    const before = snapshotCounts(stores);

    // A different worker instance receives the same job again.
    const second = makeHarness({}, stores);
    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    assertCountsUnchanged(stores, before);
    expect(second.executor.started('implement')).toBe(0);
  });
});

describe('Group D: duplicate delivery idempotency', () => {
  it('duplicate delivery of the same job does not duplicate artifact or commit', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    expect(harness.artifacts.named('implementation')).toHaveLength(1);

    const before = snapshotCounts(harness);
    const implementStarts = harness.executor.started('implement');

    // Redelivery: the same runId is handed to runProject again.
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // Deduped: no new step runs, attempts, artifacts, events, or commits.
    assertCountsUnchanged(harness, before);
    expect(harness.executor.started('implement')).toBe(implementStarts);
  });
});
