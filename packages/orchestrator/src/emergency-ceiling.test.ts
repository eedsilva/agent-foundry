import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@agent-foundry/contracts';
import { EmergencyCeilingError, type Clock, transitionWorkflowRun } from '@agent-foundry/domain';
import { makeHarness, makeStores, seedRun, type Stores } from './testing/harness.js';

const START = Date.parse('2026-07-16T12:00:00.000Z');

class TestClock implements Clock {
  constructor(private time = START) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

function workflow(nodes: unknown[]): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({
    schemaVersion: '1',
    id: 'ceiling-v1',
    name: 'Emergency ceiling fixture',
    description: 'Focused fixture for persisted active time and repair accounting.',
    stack: 'node',
    nodes,
  });
}

const ONE_AGENT = workflow([
  {
    id: 'work',
    type: 'agent',
    role: 'developer',
    taskKind: 'implementation',
    title: 'Work',
    instructions: 'Work.',
    outputArtifact: 'work',
    maxAttempts: 1,
  },
]);

const QUALITY_LOOP = workflow([
  {
    id: 'quality',
    type: 'quality-loop',
    title: 'Quality',
    maxIterations: 1,
    check: {
      id: 'check',
      type: 'agent',
      role: 'code-reviewer',
      taskKind: 'code-review',
      title: 'Check',
      instructions: 'Check.',
      outputArtifact: 'check',
    },
    repair: {
      id: 'repair',
      type: 'agent',
      role: 'developer',
      taskKind: 'repair',
      title: 'Repair',
      instructions: 'Repair.',
      outputArtifact: 'repair',
    },
    approval: { artifact: 'quality-signal', path: 'approved', equals: true },
  },
]);

async function putApproval(stores: Stores): Promise<void> {
  await stores.artifacts.put({
    projectId: 'project-1',
    name: 'quality-signal',
    content: { approved: true },
    createdBy: 'test',
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(predicate()).toBe(true);
}

describe('emergency ceiling accounting', () => {
  it('tries every finite router candidate despite legacy maxAttempts', async () => {
    const harness = makeHarness(
      { work: { kind: 'fail-once', error: () => new Error('first model failed') } },
      undefined,
      { fallback: true, workflow: ONE_AGENT },
    );
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('work')).toBe(2);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('continues a quality loop past legacy maxIterations', async () => {
    const harness = makeHarness({ check: 'gated' }, undefined, { workflow: QUALITY_LOOP });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');

    await waitUntil(() => harness.executor.started('check') === 1);
    harness.executor.release('check');
    await waitUntil(() => harness.executor.started('check') === 2);
    await putApproval(harness);
    harness.executor.release('check');
    await running;

    expect(harness.executor.started('repair')).toBe(1);
    expect((await harness.runs.get('run-1'))?.execution?.consecutiveRepairs).toBe(0);
  });

  it.each([
    [14_399_999, false],
    [14_400_000, true],
  ])('allows active elapsed %ims only below the four-hour boundary', async (elapsed, ceilings) => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);

    clock.advance(elapsed);
    harness.executor.release('work');

    if (ceilings) await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);
    else await expect(running).resolves.toBeUndefined();
    const run = await harness.runs.get('run-1');
    expect(run?.execution?.ceiling?.reason).toBe(ceilings ? 'active-time' : undefined);
  });

  it('ceilings on the tenth consecutive completed repair', async () => {
    const harness = makeHarness({}, undefined, { workflow: QUALITY_LOOP });
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toMatchObject({ name: 'EmergencyCeilingError', reason: 'consecutive-repairs' });

    const run = await harness.runs.get('run-1');
    expect(run?.execution?.consecutiveRepairs).toBe(10);
    expect(harness.executor.started('repair')).toBe(10);
  });

  it('resets consecutive repairs after successful quality approval', async () => {
    const harness = makeHarness({}, undefined, { workflow: QUALITY_LOOP });
    await seedRun(harness);
    const run = await harness.runs.get('run-1');
    await harness.runs.update(
      { ...run!, execution: { activeElapsedMs: 0, consecutiveRepairs: 9 } },
      run!.version,
    );
    await putApproval(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.execution?.consecutiveRepairs).toBe(0);
  });

  it.each(['paused', 'awaiting_approval'] as const)(
    'does not count persisted %s wait across orchestrator restart',
    async (parkedStatus) => {
      const clock = new TestClock();
      const stores = makeStores(clock);
      const first = makeHarness({}, stores, { workflow: ONE_AGENT });
      await seedRun(first);
      let run = await first.runs.get('run-1');
      run = await first.runs.update(
        transitionWorkflowRun(run!, 'running', clock.now()),
        run!.version,
      );
      if (parkedStatus === 'paused') {
        run = await first.runs.update(
          transitionWorkflowRun(run, 'pause_requested', clock.now()),
          run.version,
        );
      }
      run = await first.runs.update(
        {
          ...transitionWorkflowRun(run, parkedStatus, clock.now()),
          execution: { activeElapsedMs: 500, consecutiveRepairs: 0 },
        },
        run.version,
      );

      clock.advance(8 * 60 * 60 * 1_000);
      await first.runs.update(transitionWorkflowRun(run, 'queued', clock.now()), run.version);
      const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
      await restarted.orchestrator.runProject('project-1', undefined, 'run-1');

      expect((await restarted.runs.get('run-1'))?.execution?.activeElapsedMs).toBe(500);
    },
  );

  it('gives cancellation precedence when the active-time boundary is reached', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);

    clock.advance(14_400_000);
    await harness.service.cancelRun('run-1');
    harness.executor.release('work');
    await running;

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('cancelled');
    expect(run?.execution?.ceiling).toBeUndefined();
  });

  it('aborts a long-running executor when active time reaches four hours', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: { kind: 'hang-until-abort' } }, stores, {
      workflow: ONE_AGENT,
    });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);

    clock.advance(14_400_000);

    await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);
    expect((await harness.runs.get('run-1'))?.execution?.ceiling?.reason).toBe('active-time');
  });

  it('does not reactivate a run whose ceiling was already persisted', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({}, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    const run = await harness.runs.get('run-1');
    await harness.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 14_400_000,
          consecutiveRepairs: 0,
          ceiling: { reason: 'active-time', reachedAt: clock.now().toISOString() },
        },
      },
      run!.version,
    );

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    expect((await harness.runs.get('run-1'))?.execution?.activeSince).toBeUndefined();
  });
});
