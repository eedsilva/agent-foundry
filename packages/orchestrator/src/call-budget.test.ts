import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionSchema, type WorkflowDefinition } from '@agent-foundry/contracts';
import {
  CallBudgetExhaustedError,
  EmergencyCeilingError,
  RunCancelledError,
} from '@agent-foundry/domain';
import { makeHarness, seedRun } from './testing/harness.js';

/**
 * Test-only seam onto the private per-task reservation (#604): calling it
 * directly, rather than through a full `executeStep`, sidesteps unrelated CAS
 * writes earlier in step dispatch (`setCurrentStep` and friends) that would
 * otherwise race two concurrent full dispatches and throw a `VersionConflictError`
 * that has nothing to do with the ledger being tested here.
 */
interface HasReserveTaskCall {
  reserveTaskCall(
    runId: string,
    nodeId: string,
    taskId: string,
    callClass: 'implement' | 'repair',
    limit: number,
    signal: AbortSignal,
  ): Promise<void>;
}

const PLAN_STEP = {
  id: 'plan',
  type: 'agent' as const,
  role: 'planner',
  taskKind: 'planning',
  title: 'Plan',
  instructions: 'Plan the work.',
  outputArtifact: 'plan.current',
  outputContract: 'task-graph' as const,
};

const GENERATED_GRAPH = {
  schemaVersion: '1',
  goal: 'Ship it',
  modules: [{ id: 'crud:work', acceptanceChannel: 'deterministic-only' as const }],
  tasks: [
    {
      id: 'T1',
      title: 'Do the thing',
      dependsOn: [],
      deliverables: ['src/index.ts'],
      acceptanceCheck: 'The thing works',
      acceptanceMode: 'deterministic-only' as const,
      module: 'crud:work',
    },
  ],
};

/** Plan → one `for-each-task` task, gated by an empty (always-passing) deterministic verify. */
const TASK_GRAPH_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'call-budget-graph-v1',
  name: 'Call budget task-graph fixture',
  description: 'Plans a single task, then implements it through the ledger-guarded dispatch.',
  stack: 'node',
  nodes: [
    PLAN_STEP,
    {
      id: 'task-execution',
      type: 'for-each-task',
      title: 'Implement tasks',
      taskGraphArtifact: 'plan.current',
      implement: {
        id: 'implement',
        type: 'agent',
        role: 'developer',
        taskKind: 'implementation',
        title: 'Implement task',
        instructions: 'Implement the task.',
        inputArtifacts: ['plan.current'],
        outputArtifact: 'implementation.report',
        mutatesWorkspace: true,
        maxAttempts: 1,
      },
      verify: {
        id: 'verify-task',
        type: 'verify',
        title: 'Verify task',
        outputArtifact: 'verification.report',
        scripts: [],
      },
      repair: {
        id: 'repair-task',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair task',
        instructions: 'Repair the task.',
        inputArtifacts: ['verification.report'],
        outputArtifact: 'verification.fix',
        mutatesWorkspace: true,
        maxAttempts: 2,
      },
    },
  ],
});

function planAgentOutput(request: { stepId: string }) {
  if (request.stepId === 'plan') {
    return {
      schemaVersion: '1' as const,
      status: 'completed' as const,
      summary: 'Planned.',
      data: GENERATED_GRAPH,
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    };
  }
  return undefined;
}

describe('ADR-0073 Call Budget ledger (#604)', () => {
  it('grants the first implement reservation and denies a second for the same task', async () => {
    const harness = makeHarness({}, undefined, { workflow: TASK_GRAPH_WORKFLOW });
    await seedRun(harness);
    const orchestrator = harness.orchestrator as unknown as HasReserveTaskCall;
    const signal = new AbortController().signal;

    await orchestrator.reserveTaskCall('run-1', 'task-execution', 'T1', 'implement', 1, signal);
    expect((await harness.runs.get('run-1'))?.execution?.callBudget).toEqual({
      'task-execution:T1': {
        nodeId: 'task-execution',
        taskId: 'T1',
        implementUsed: 1,
        implementLimit: 1,
        repairUsed: 0,
        repairLimit: 0,
      },
    });

    await expect(
      orchestrator.reserveTaskCall('run-1', 'task-execution', 'T1', 'implement', 1, signal),
    ).rejects.toBeInstanceOf(CallBudgetExhaustedError);
    // Denial never re-reserves: the ledger is unchanged by the losing call.
    expect(
      (await harness.runs.get('run-1'))?.execution?.callBudget?.['task-execution:T1'],
    ).toMatchObject({ implementUsed: 1 });
  });

  // Two reservations racing for the same task's last slot must resolve to
  // exactly one grant, never both and never zero — the CAS retry loop inside
  // `updateExecution` re-reads the freshest ledger on every attempt, so the
  // loser always sees the winner's write before it decides.
  it('grants exactly one of two concurrent reservations on the last slot', async () => {
    const harness = makeHarness({}, undefined, { workflow: TASK_GRAPH_WORKFLOW });
    await seedRun(harness);
    const orchestrator = harness.orchestrator as unknown as HasReserveTaskCall;
    const signal = new AbortController().signal;
    const reserve = () =>
      orchestrator.reserveTaskCall('run-1', 'task-execution', 'T1', 'implement', 1, signal);

    const results = await Promise.allSettled([reserve(), reserve()]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CallBudgetExhaustedError);
    expect(
      (await harness.runs.get('run-1'))?.execution?.callBudget?.['task-execution:T1'],
    ).toMatchObject({ implementUsed: 1 });
  });

  // Cancellation observed before the reservation is granted is "cancel before
  // spawn": the ledger must show zero consumption, not a phantom reserved
  // unit nobody will ever dispatch.
  it('spends nothing when the run was already cancelled before the reservation', async () => {
    const harness = makeHarness({}, undefined, { workflow: TASK_GRAPH_WORKFLOW });
    await seedRun(harness);
    const seeded = await harness.runs.get('run-1');
    if (!seeded) throw new Error('run-1 not seeded');
    await harness.runs.update({ ...seeded, status: 'cancel_requested' }, seeded.version);
    const orchestrator = harness.orchestrator as unknown as HasReserveTaskCall;

    await expect(
      orchestrator.reserveTaskCall(
        'run-1',
        'task-execution',
        'T1',
        'implement',
        1,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RunCancelledError);
    expect((await harness.runs.get('run-1'))?.execution?.callBudget).toBeUndefined();
  });

  it('records exactly the one implement reservation a clean real run spends', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      agentOutput: planAgentOutput,
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', TASK_GRAPH_WORKFLOW.id, 'run-1');

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    // repairLimit stays 0: the task's verify gate passes on the first try, so
    // repair is never reserved — only implement's actually-spent unit shows.
    expect(run?.execution?.callBudget).toEqual({
      'task-execution:T1': {
        nodeId: 'task-execution',
        taskId: 'T1',
        implementUsed: 1,
        implementLimit: 1,
        repairUsed: 0,
        repairLimit: 0,
      },
    });
  });

  // A task that already spent its Call Budget (e.g. a prior run left the
  // ledger at its limit) must refuse a further implement call rather than
  // spend one anyway — converging into the same preserve-draft ceiling
  // machinery as the wall-clock and repair-count ceilings, under its own
  // 'call-budget-exhausted' reason (#604).
  it('preserves a draft and pauses when a task dispatch finds its budget already spent', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      agentOutput: planAgentOutput,
    });
    await seedRun(harness);
    const seeded = await harness.runs.get('run-1');
    if (!seeded) throw new Error('run-1 not seeded');
    await harness.runs.update(
      {
        ...seeded,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          callBudget: {
            'task-execution:T1': {
              nodeId: 'task-execution',
              taskId: 'T1',
              implementUsed: 1,
              implementLimit: 1,
              repairUsed: 0,
              repairLimit: 2,
            },
          },
        },
      },
      seeded.version,
    );

    await expect(
      harness.orchestrator.runProject('project-1', TASK_GRAPH_WORKFLOW.id, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('failed');
    expect(run?.execution?.ceiling?.reason).toBe('call-budget-exhausted');
    expect(run?.execution?.ceiling?.draftBranch).toBeDefined();
    expect(
      harness.events.events.find((event) => event.type === 'run.call_budget_exhausted'),
    ).toBeDefined();
    // The ledger itself is untouched by the denial — still exactly the one
    // spent unit, not two.
    expect(run?.execution?.callBudget?.['task-execution:T1']).toMatchObject({ implementUsed: 1 });
  });

  // A real quality-gate failure (a failing lint/build/test step) must never
  // surface as a Call Budget exhaustion — only a reservation denial from the
  // ledger itself may reach the 'call-budget-exhausted' ceiling.
  it('keeps a failing task at its own failure reason instead of relabeling it as budget exhaustion', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      agentOutput: planAgentOutput,
      // Every deterministic verify call reports failure, so the task's
      // repair ladder (maxAttempts: 2) runs to exhaustion — a real
      // `QualityGateError`, spending exactly its 2-unit repair budget along
      // the way, never denied by the ledger.
      verification: () => ({
        schemaVersion: '1',
        approved: false,
        packageManager: 'npm',
        summary: 'checks failed',
        commands: [],
        createdAt: new Date().toISOString(),
      }),
    });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', TASK_GRAPH_WORKFLOW.id, 'run-1');
    await expect(running).rejects.not.toBeInstanceOf(EmergencyCeilingError);

    const run = await harness.runs.get('run-1');
    expect(run?.execution?.ceiling?.reason).not.toBe('call-budget-exhausted');
    expect(run?.execution?.callBudget?.['task-execution:T1']).toMatchObject({
      implementUsed: 1,
      repairUsed: 2,
    });
    expect(
      harness.events.events.find((event) => event.type === 'run.call_budget_exhausted'),
    ).toBeUndefined();
    // The pre-existing 4h/10-repairs fail-safe accounting lives in the same
    // `execution` object as the new ledger — proves the two rounds of real
    // repair calls above only moved `callBudget`, not the unrelated
    // wall-clock/repair-streak counters the emergency ceiling reads (#604).
    expect(run?.execution?.consecutiveRepairs).toBe(2);
    expect(run?.execution?.ceiling).toBeUndefined();
  });
});
