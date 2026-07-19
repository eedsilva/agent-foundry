import { describe, expect, it } from 'vitest';
import {
  WorkflowDefinitionSchema,
  type AgentArtifact,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
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

const VERIFY_ONLY = workflow([
  {
    id: 'verify',
    type: 'verify',
    title: 'Verify',
    outputArtifact: 'verification-report',
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
      outputArtifact: 'quality-signal',
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

const APPROVED_CHECK: AgentArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Quality check approved.',
  approved: true,
  data: {},
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};

function makeQualityHarness(behaviors: Parameters<typeof makeHarness>[0], stores?: Stores) {
  let approved = false;
  const harness = makeHarness(behaviors, stores, {
    workflow: QUALITY_LOOP,
    agentOutput: (request) => (request.stepId === 'check' && approved ? APPROVED_CHECK : undefined),
  });
  return {
    harness,
    approveNextCheck: (): void => {
      approved = true;
    },
  };
}

async function putUnrelatedApproval(stores: Stores): Promise<void> {
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
  it('preserves a draft, restores the verified head, and finalizes the run once', async () => {
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
    expect(run).toMatchObject({
      status: 'failed',
      error: { name: 'EmergencyCeilingError', code: 'EMERGENCY_CEILING' },
      execution: {
        lastVerifiedCheckpoint: 'initial-head',
        ceiling: { draftBranch: 'draft/run-1', draftCommit: expect.any(String) },
      },
    });
    expect(stores.workspaces.drafts).toEqual(['draft/run-1']);
    expect(stores.workspaces.current).toBe('initial-head');
    expect((await stores.projects.get('project-1'))?.status).toBe('failed');
    expect(
      stores.events.types().filter((type) => type === 'run.emergency_ceiling_reached'),
    ).toHaveLength(1);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(stores.workspaces.drafts).toEqual(['draft/run-1']);
    expect(
      stores.events.types().filter((type) => type === 'run.emergency_ceiling_reached'),
    ).toHaveLength(1);
  });

  it('reconstructs ceiling finalization after the draft was created but not persisted', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const first = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(first);
    stores.workspaces.onAfterPreserveDraft = () => {
      throw new Error('simulated crash after draft restore');
    };
    const interrupted = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => first.executor.started('work') === 1);
    clock.advance(14_400_000);
    first.executor.release('work');

    await expect(interrupted).rejects.toThrow('simulated crash after draft restore');
    expect(stores.workspaces.drafts).toEqual(['draft/run-1']);
    expect((await stores.runs.get('run-1'))?.execution?.ceiling?.draftBranch).toBeUndefined();

    stores.workspaces.onAfterPreserveDraft = undefined;
    const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
    await expect(
      restarted.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);
    await restarted.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(stores.workspaces.drafts).toEqual(['draft/run-1']);
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(
      stores.events.types().filter((type) => type === 'run.emergency_ceiling_reached'),
    ).toHaveLength(1);
  });

  it('lets cancellation win when requested while the draft operation is finishing', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    stores.workspaces.onAfterPreserveDraft = async () => {
      stores.workspaces.onAfterPreserveDraft = undefined;
      await harness.service.cancelRun('run-1');
    };
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);
    clock.advance(14_400_000);
    harness.executor.release('work');

    await expect(running).resolves.toBeUndefined();

    const run = await stores.runs.get('run-1');
    expect(run?.status).toBe('cancelled');
    expect(run?.error).toBeUndefined();
    expect(run?.execution?.ceiling?.draftBranch).toBeUndefined();
    expect(stores.workspaces.drafts).toEqual([]);
    expect(stores.events.types()).not.toContain('run.emergency_ceiling_reached');
  });

  it('finishes the deduplicated event on redelivery after the run was already failed', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const first = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(first);
    stores.events.onBeforeAppend = (event) => {
      if (event.type !== 'run.emergency_ceiling_reached') return;
      stores.events.onBeforeAppend = undefined;
      throw new Error('simulated event-store outage');
    };
    const interrupted = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => first.executor.started('work') === 1);
    clock.advance(14_400_000);
    first.executor.release('work');

    await expect(interrupted).rejects.toThrow('simulated event-store outage');
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(stores.events.types()).not.toContain('run.emergency_ceiling_reached');

    const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
    await restarted.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.projects.get('project-1'))?.status).toBe('failed');
    expect(
      stores.events.types().filter((type) => type === 'run.emergency_ceiling_reached'),
    ).toHaveLength(1);
  });

  it('reconstructs after the failed run write precedes summary and event finalization', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const first = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(first);
    stores.runs.onAfterUpdate = (run) => {
      if (run.status !== 'failed') return;
      stores.runs.onAfterUpdate = undefined;
      throw new Error('simulated crash after terminal write');
    };
    const interrupted = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => first.executor.started('work') === 1);
    clock.advance(14_400_000);
    first.executor.release('work');

    await expect(interrupted).rejects.toThrow('simulated crash after terminal write');
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(stores.events.types()).not.toContain('run.emergency_ceiling_reached');

    const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
    await restarted.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.projects.get('project-1'))?.status).toBe('failed');
    expect(
      stores.events.types().filter((type) => type === 'run.emergency_ceiling_reached'),
    ).toHaveLength(1);
  });

  it('lets cancellation win a version race with the failed transition', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    stores.runs.onBeforeUpdate = async (candidate) => {
      if (candidate.status !== 'failed') return;
      stores.runs.onBeforeUpdate = undefined;
      await harness.service.cancelRun('run-1');
    };
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);
    clock.advance(14_400_000);
    harness.executor.release('work');

    await expect(running).resolves.toBeUndefined();
    expect((await stores.runs.get('run-1'))?.status).toBe('cancelled');
    expect(stores.events.types()).not.toContain('run.emergency_ceiling_reached');
  });

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

  it('ignores a globally latest approval and continues until the current check approves', async () => {
    const { harness, approveNextCheck } = makeQualityHarness({ check: 'gated' });
    await seedRun(harness);
    let injectedApproval = false;
    harness.artifacts.onAfterPut = (name) => {
      if (name !== 'quality-signal' || injectedApproval) return;
      injectedApproval = true;
      void putUnrelatedApproval(harness);
    };
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');

    await waitUntil(() => harness.executor.started('check') === 1);
    harness.executor.release('check');
    await waitUntil(() => harness.executor.started('check') === 2);
    expect(harness.executor.started('repair')).toBe(1);
    approveNextCheck();
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
    expect(run?.execution?.countedRepairStepRunIds).toHaveLength(10);
  });

  it('does not recount several completed repairs after a crash and restart', async () => {
    const stores = makeStores();
    const first = makeHarness({ check: 'gated' }, stores, { workflow: QUALITY_LOOP });
    await seedRun(first);
    const interrupted = first.orchestrator.runProject('project-1', undefined, 'run-1');

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      await waitUntil(() => first.executor.started('check') === iteration);
      first.executor.release('check');
      await waitUntil(() => first.executor.started('repair') === iteration);
    }
    await waitUntil(() => first.executor.started('check') === 4);
    stores.power.on = false;
    first.executor.release('check');
    await expect(interrupted).rejects.toThrow('simulated power loss');
    stores.power.on = true;

    expect((await stores.runs.get('run-1'))?.execution?.consecutiveRepairs).toBe(3);
    const counted = (await stores.runs.get('run-1'))?.execution?.countedRepairStepRunIds;
    expect(counted).toHaveLength(3);

    const { harness: restarted, approveNextCheck } = makeQualityHarness({ check: 'gated' }, stores);
    const resumed = restarted.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => restarted.executor.started('check') === 1);
    expect((await stores.runs.get('run-1'))?.execution?.consecutiveRepairs).toBe(3);
    expect((await stores.runs.get('run-1'))?.execution?.countedRepairStepRunIds).toEqual(counted);
    approveNextCheck();
    restarted.executor.release('check');
    await resumed;

    expect((await stores.runs.get('run-1'))?.execution).toMatchObject({
      consecutiveRepairs: 0,
      countedRepairStepRunIds: [],
    });
  });

  it('resets consecutive repairs after successful quality approval', async () => {
    const { harness, approveNextCheck } = makeQualityHarness({});
    await seedRun(harness);
    const run = await harness.runs.get('run-1');
    await harness.runs.update(
      { ...run!, execution: { activeElapsedMs: 0, consecutiveRepairs: 9 } },
      run!.version,
    );
    approveNextCheck();

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.execution).toMatchObject({
      consecutiveRepairs: 0,
      countedRepairStepRunIds: [],
    });
  });

  it.each(['agent', 'verifier'] as const)(
    'classifies %s failure below four hours normally and at four hours as a ceiling',
    async (kind) => {
      for (const [elapsed, ceilings] of [
        [14_399_999, false],
        [14_400_000, true],
      ] as const) {
        const clock = new TestClock();
        const stores = makeStores(clock);
        const failure = (): never => {
          clock.advance(elapsed);
          throw new Error(`${kind} failed`);
        };
        const harness = makeHarness(
          kind === 'agent' ? { work: { kind: 'fail-always', error: failure } } : {},
          stores,
          {
            workflow: kind === 'agent' ? ONE_AGENT : VERIFY_ONLY,
            ...(kind === 'verifier' ? { verification: failure } : {}),
          },
        );
        await seedRun(harness);

        const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
        if (ceilings) await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);
        else await expect(running).rejects.toThrow(`${kind} failed`);
        expect((await stores.runs.get('run-1'))?.execution?.ceiling?.reason).toBe(
          ceilings ? 'active-time' : undefined,
        );
        expect((await stores.runs.get('run-1'))?.status).toBe('failed');
      }
    },
  );

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

  it('finalizes cancellation requested after the ceiling CAS but before outer handling', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    stores.runs.onAfterUpdate = async (updated) => {
      if (!updated.execution?.ceiling) return;
      stores.runs.onAfterUpdate = undefined;
      await harness.service.cancelRun('run-1');
    };
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);

    clock.advance(14_400_000);
    harness.executor.release('work');
    await expect(running).resolves.toBeUndefined();

    expect((await stores.runs.get('run-1'))?.status).toBe('cancelled');
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
          lastVerifiedCheckpoint: 'initial-head',
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

  it('finalizes an expired restarted run whose initial checkpoint was never persisted', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const seeded = makeHarness({}, stores, { workflow: ONE_AGENT });
    await seedRun(seeded);
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...transitionWorkflowRun(run!, 'running', clock.now()),
        execution: {
          activeElapsedMs: 0,
          activeSince: clock.now().toISOString(),
          consecutiveRepairs: 0,
        },
      },
      run!.version,
    );
    clock.advance(14_400_000);

    const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
    await expect(
      restarted.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    expect(await stores.runs.get('run-1')).toMatchObject({
      status: 'failed',
      error: { code: 'EMERGENCY_CEILING' },
      execution: {
        lastVerifiedCheckpoint: 'initial-head',
        ceiling: { reason: 'active-time', draftBranch: 'draft/run-1' },
      },
    });
    expect(stores.workspaces.current).toBe('initial-head');
    expect(stores.events.types()).toContain('run.emergency_ceiling_reached');
  });

  it('lets cancellation win after the final boundary check', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    stores.runs.onAfterUpdate = async (candidate) => {
      if (
        candidate.status !== 'running' ||
        candidate.execution?.activeSince ||
        harness.executor.started('work') === 0
      )
        return;
      stores.runs.onAfterUpdate = undefined;
      await harness.service.cancelRun('run-1');
    };

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).resolves.toBeUndefined();

    expect((await stores.runs.get('run-1'))?.status).toBe('cancelled');
    expect(stores.events.types()).not.toContain('project.completed');
  });

  it('finalizes a ceiling persisted after the final boundary check', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({}, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    stores.runs.onAfterUpdate = async (candidate) => {
      if (
        candidate.status !== 'running' ||
        candidate.execution?.activeSince ||
        harness.executor.started('work') === 0
      )
        return;
      stores.runs.onAfterUpdate = undefined;
      await stores.runs.update(
        {
          ...candidate,
          execution: {
            ...candidate.execution!,
            ceiling: { reason: 'active-time', reachedAt: clock.now().toISOString() },
          },
        },
        candidate.version,
      );
    };

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    expect(await stores.runs.get('run-1')).toMatchObject({
      status: 'failed',
      error: { code: 'EMERGENCY_CEILING' },
      execution: { ceiling: { draftBranch: 'draft/run-1' } },
    });
    expect(stores.events.types()).not.toContain('project.completed');
    expect(stores.events.types()).toContain('run.emergency_ceiling_reached');
  });

  it('ceilings when stopping active time reaches exactly four hours', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ work: 'gated' }, stores, { workflow: ONE_AGENT });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await waitUntil(() => harness.executor.started('work') === 1);
    clock.advance(14_399_999);
    stores.runs.onAfterUpdate = async (candidate) => {
      if (candidate.status !== 'running' || candidate.execution?.activeSince) return;
      stores.runs.onAfterUpdate = undefined;
      clock.advance(1);
      await stores.runs.update(
        {
          ...candidate,
          execution: { ...candidate.execution!, activeElapsedMs: 14_400_000 },
        },
        candidate.version,
      );
    };
    harness.executor.release('work');

    await expect(running).rejects.toBeInstanceOf(EmergencyCeilingError);

    expect(await stores.runs.get('run-1')).toMatchObject({
      status: 'failed',
      error: { code: 'EMERGENCY_CEILING' },
      execution: { activeElapsedMs: 14_400_000, ceiling: { reason: 'active-time' } },
    });
    expect(stores.events.types()).not.toContain('project.completed');
  });

  it('advances the verified checkpoint only after an approved verification result', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      workflow: VERIFY_ONLY,
      verification: () => {
        stores.workspaces.current = 'approved-head';
        return {
          schemaVersion: '1',
          approved: true,
          packageManager: 'npm',
          summary: 'approved',
          commands: [],
          createdAt: new Date().toISOString(),
        };
      },
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.execution?.lastVerifiedCheckpoint).toBe(
      'approved-head',
    );
  });

  it('keeps the prior checkpoint when verification is not approved', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      workflow: VERIFY_ONLY,
      verification: () => {
        stores.workspaces.current = 'unapproved-head';
        return {
          schemaVersion: '1',
          approved: false,
          packageManager: 'npm',
          summary: 'not approved',
          commands: [],
          createdAt: new Date().toISOString(),
        };
      },
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.execution?.lastVerifiedCheckpoint).toBe(
      'initial-head',
    );
  });

  it('counts fail-safe wall time while a persisted run remains running across restart', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const seeded = makeHarness({}, stores, { workflow: ONE_AGENT });
    await seedRun(seeded);
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...transitionWorkflowRun(run!, 'running', clock.now()),
        execution: {
          activeElapsedMs: 1_000,
          activeSince: clock.now().toISOString(),
          consecutiveRepairs: 0,
        },
      },
      run!.version,
    );

    clock.advance(2_000);
    const restarted = makeHarness({}, stores, { workflow: ONE_AGENT });
    await restarted.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.execution?.activeElapsedMs).toBe(3_000);
  });
});

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

  it('rejects inspecting a draft for a run that never reached a ceiling', async () => {
    const harness = makeHarness({ work: 'instant' }, undefined, { workflow: ONE_AGENT });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await expect(harness.service.getDraft('run-1')).rejects.toThrow('has no preserved draft');
  });

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
});
