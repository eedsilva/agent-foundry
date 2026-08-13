import { describe, expect, it } from 'vitest';
import type {
  ExecutableStep,
  ForEachTaskStep,
  PlanTask,
  Project,
  StoredArtifact,
  WorkflowDefinition,
} from '@agent-foundry/contracts';
import { WorkflowDefinitionSchema } from '@agent-foundry/contracts';
import { ExecutionError, SystemClock } from '@agent-foundry/domain';
import {
  FakeWorkspaces,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryStepAttempts,
  InMemoryStepRuns,
  SequentialIds,
} from './testing/harness.js';
import {
  TaskGraphRunner,
  type TaskGraphRuntime,
  type TaskGraphStepExecution,
} from './task-graph-runner.js';

const project: Project = {
  id: 'project-1',
  name: 'Task graph runner fixture',
  workflowId: 'task-graph-v1',
  policyId: 'default',
  status: 'running',
  version: 1,
  createdAt: '2026-08-07T12:00:00.000Z',
  updatedAt: '2026-08-07T12:00:00.000Z',
  currentRunId: 'run-1',
};

const workflow = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'task-graph-v1',
  name: 'Task graph runner fixture',
  description: 'Runs a task graph.',
  stack: 'node',
  nodes: [
    {
      id: 'task-execution',
      type: 'for-each-task',
      title: 'Execute tasks',
      taskGraphArtifact: 'plan.current',
      implement: {
        id: 'implement',
        type: 'agent',
        role: 'developer',
        taskKind: 'implementation',
        title: 'Implement task',
        instructions: 'Implement the task.',
        outputArtifact: 'implementation.report',
        mutatesWorkspace: true,
        maxAttempts: 1,
      },
    },
  ],
});

const gatedWorkflow = WorkflowDefinitionSchema.parse({
  ...workflow,
  nodes: [
    {
      ...workflow.nodes[0],
      verify: {
        id: 'verify-task',
        type: 'verify',
        title: 'Verify task',
        outputArtifact: 'verification.report',
      },
      repair: {
        id: 'repair-task',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair task',
        instructions: 'Repair the failing checks.',
        inputArtifacts: ['verification.report'],
        outputArtifact: 'verification.fix',
        mutatesWorkspace: true,
        maxAttempts: 1,
      },
    },
  ],
});

const retryWorkflow = WorkflowDefinitionSchema.parse({
  ...gatedWorkflow,
  nodes: [
    {
      ...gatedWorkflow.nodes[0],
      implement: {
        ...(gatedWorkflow.nodes[0] as ForEachTaskStep).implement,
        maxAttempts: 2,
      },
    },
  ],
});

const browserWorkflow = WorkflowDefinitionSchema.parse({
  ...gatedWorkflow,
  nodes: [
    {
      ...gatedWorkflow.nodes[0],
      browser: {
        plan: {
          id: 'plan-task-browser-test',
          type: 'agent',
          role: 'tester',
          taskKind: 'verification',
          title: 'Plan browser test',
          instructions: 'Plan the browser test.',
          outputArtifact: 'browser-test.plan',
        },
        check: {
          id: 'assert-task',
          type: 'verify',
          title: 'Assert task',
          outputArtifact: 'browser-verification.report',
          browserTestPlanArtifact: 'browser-test.plan',
          scripts: [],
          includeGitDiffCheck: false,
        },
      },
    },
  ],
});

const singleExecutorWorkflow = WorkflowDefinitionSchema.parse({
  ...retryWorkflow,
  routing: [{ taskKind: 'implementation', executors: ['claude'] }],
});

describe('TaskGraphRunner', () => {
  it('runs the first dependency-ready task instead of declaration order', async () => {
    const executedSteps: string[] = [];
    const fixture = await setupRunner(
      workflow,
      [task('T1', ['T2'], 'Blocked task'), task('T2', [], 'Ready task')],
      (input, artifacts) => {
        executedSteps.push(input.step.id);
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content: completedArtifact(input.step),
          createdBy: 'test-runtime',
        });
      },
    );

    const result = await fixture.run();

    expect(executedSteps).toEqual(['implement.T2', 'implement.T1']);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'task.completed')
        .map((event) => event.data.taskId),
    ).toEqual(['T2', 'T1']);
    expect(result.content).toMatchObject({ summary: 'implement.T1 completed.' });
  });

  it('repairs a red deterministic gate before completing the task', async () => {
    const executedSteps: string[] = [];
    let verification = 0;
    const fixture = await setupRunner(
      gatedWorkflow,
      [task('T1')],
      async (input, artifacts, stores) => {
        executedSteps.push(input.step.id);
        if (input.step.type === 'verify') {
          verification += 1;
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: {
              schemaVersion: '1',
              approved: verification > 1,
              packageManager: 'npm',
              summary: verification > 1 ? 'Checks passed.' : 'Checks failed.',
              commands: [],
              createdAt: '2026-08-07T12:00:00.000Z',
            },
            createdBy: 'test-runtime',
          });
        }
        if (input.step.id === 'repair-task.T1') {
          await stores.stepAttempts.create({
            id: 'repair-attempt-1',
            runId: 'run-1',
            stepRunId: 'repair-step-run-1',
            sequence: 1,
            executorKind: 'agent',
            provider: 'codex',
            model: 'gpt-5',
            status: 'succeeded',
            version: 1,
            createdAt: '2026-08-07T12:00:00.000Z',
            updatedAt: '2026-08-07T12:00:01.000Z',
            startedAt: '2026-08-07T12:00:00.000Z',
            completedAt: '2026-08-07T12:00:01.000Z',
            commit: 'repair-commit',
            context: {
              projectId: project.id,
              workflowId: gatedWorkflow.id,
              nodeId: 'task-execution',
              stepId: 'repair-task.T1',
              iteration: 1,
            },
            inputArtifacts: [],
            outputArtifacts: [],
          });
        }
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content: completedArtifact(input.step),
          createdBy: 'test-runtime',
          ...(input.step.id === 'repair-task.T1'
            ? { stepRunId: 'repair-step-run-1', attemptId: 'repair-attempt-1' }
            : {}),
        });
      },
    );

    await fixture.run();

    expect(executedSteps).toEqual([
      'implement.T1',
      'verify-task.T1',
      'repair-task.T1',
      'verify-task.T1',
    ]);
    expect(
      fixture.events.events
        .filter((event) => event.data.taskId === 'T1')
        .map((event) => event.type),
    ).toEqual(['task.started', 'quality.repair_requested', 'quality.approved', 'task.completed']);
    expect(
      fixture.events.events.find((event) => event.type === 'task.completed')?.data.commit,
    ).toBe('repair-commit');
  });

  it('advances the executor only after a red quality gate and rolls back the attempt', async () => {
    const implementationRoutes: Array<number | undefined> = [];
    const fixture = await setupRunner(retryWorkflow, [task('T1')], (input, artifacts) => {
      if (input.step.id === 'implement.T1') implementationRoutes.push(input.routingStartIndex);
      const content =
        input.step.type === 'verify'
          ? {
              schemaVersion: '1',
              approved: input.iteration === 3,
              packageManager: 'npm',
              summary: input.iteration === 3 ? 'Checks passed.' : 'Checks failed.',
              commands: [],
              createdAt: '2026-08-07T12:00:00.000Z',
            }
          : completedArtifact(input.step);
      return artifacts.put({
        projectId: input.project.id,
        name: input.step.outputArtifact,
        content,
        createdBy: 'test-runtime',
      });
    });

    await fixture.run();

    expect(implementationRoutes).toEqual([0, 1]);
    expect(fixture.workspaces.rollbacks).toEqual(['initial-head']);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'task.failed')
        .map((event) => event.data.attempt),
    ).toEqual([1]);
    expect(
      fixture.events.events.find((event) => event.type === 'task.completed')?.data.attempt,
    ).toBe(2);
  });

  it('reverifies deterministic checks after repairing a browser assertion', async () => {
    const executedSteps: string[] = [];
    let browserChecks = 0;
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts) => {
        executedSteps.push(`${input.step.id}:${input.iteration ?? 0}`);
        let content: object = completedArtifact(input.step);
        if (input.step.id === 'verify-task.T1') {
          content = verificationReport(true);
        } else if (input.step.id === 'plan-task-browser-test.T1') {
          content = browserPlan();
        } else if (input.step.id === 'assert-task.T1') {
          browserChecks += 1;
          content = browserReport(browserChecks > 1);
        }
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await fixture.run();

    expect(executedSteps).toEqual([
      'implement.T1:1',
      'verify-task.T1:1',
      'plan-task-browser-test.T1:1',
      'assert-task.T1:1',
      'repair-task-browser.T1:1',
      'assert-task.T1:2',
      'verify-task.T1:3',
    ]);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'task.completed')
        .map((event) => event.data.taskId),
    ).toEqual(['T1']);
  });

  it('routes a ui-quality-gated browser report through the same repair loop as a functional failure', async () => {
    // The first `browser-verification.report` here is functionally green —
    // every step `passed` — but `approved: false` because Task 2's
    // `gateOnUiQuality` already flipped it for a low judge score (#477).
    // `assertTask` must not know or care why `approved` is false: same
    // repair invocation, same `recordCompletedRepair` call, no separate
    // event kind or counting path for the ui-quality case.
    // Builds its own TaskGraphRuntime (like 'derives a resumed attempt...'
    // below) instead of the shared setupRunner helper this test's sibling
    // ('reverifies deterministic checks...') uses — setupRunner hardcodes
    // recordCompletedRepair: () => Promise.resolve(), and this test needs to
    // observe those calls.
    const power = { on: true };
    const artifacts = new InMemoryArtifacts(power);
    const events = new InMemoryEvents(power);
    const stepRuns = new InMemoryStepRuns(power);
    const stepAttempts = new InMemoryStepAttempts(power);
    const workspaces = new FakeWorkspaces(power);
    await putTaskGraph(artifacts, [{ ...task('T1'), acceptanceMode: 'browser-visible' }]);

    const executedSteps: string[] = [];
    const repairPinnedArtifactNames: string[][] = [];
    const completedRepairs: Array<{ stepId: string; iteration: number }> = [];
    let browserChecks = 0;

    const runtime: TaskGraphRuntime = {
      executeStep: (input) => {
        executedSteps.push(`${input.step.id}:${input.iteration ?? 0}`);
        if (input.step.id === 'repair-task-browser.T1') {
          repairPinnedArtifactNames.push((input.pinnedArtifacts ?? []).map((ref) => ref.name));
        }
        let content: object = completedArtifact(input.step);
        if (input.step.id === 'verify-task.T1') {
          content = verificationReport(true);
        } else if (input.step.id === 'plan-task-browser-test.T1') {
          content = browserPlan();
        } else if (input.step.id === 'assert-task.T1') {
          browserChecks += 1;
          content =
            browserChecks === 1 ? uiQualityGatedBrowserReport() : passingUiQualityBrowserReport();
        }
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
      assertExecutionMayContinue: () => Promise.resolve(),
      isControlFlowError: () => false,
      recordDeterministicOutcome: () => Promise.resolve(),
      recordCompletedRepair: (input) => {
        completedRepairs.push({ stepId: input.stepId, iteration: input.iteration });
        return Promise.resolve();
      },
      resetConsecutiveRepairs: () => Promise.resolve(),
    };
    const runner = new TaskGraphRunner({
      artifacts,
      events,
      stepRuns,
      stepAttempts,
      workspaces,
      clock: new SystemClock(),
      ids: new SequentialIds(),
      runtime,
    });
    const node = browserWorkflow.nodes[0];
    if (node?.type !== 'for-each-task') throw new Error('Expected for-each-task fixture');

    await runner.run({
      project,
      workflow: browserWorkflow,
      node,
      runId: 'run-1',
      signal: new AbortController().signal,
    });

    expect(executedSteps).toEqual([
      'implement.T1:1',
      'verify-task.T1:1',
      'plan-task-browser-test.T1:1',
      'assert-task.T1:1',
      'repair-task-browser.T1:1',
      'assert-task.T1:2',
      'verify-task.T1:3',
    ]);
    // Repair invocation: identical mechanics to a functional-failure
    // repair — the gated report rides along as a pinned input artifact.
    expect(repairPinnedArtifactNames).toEqual([
      ['browser-test.plan', 'browser-verification.report'],
    ]);
    // recordCompletedRepair fires exactly once for the one repair round —
    // the same call a functional-failure repair loop makes, which is what
    // lets the existing emergency-ceiling coverage apply unchanged here.
    expect(completedRepairs).toEqual([{ stepId: 'repair-task-browser.T1', iteration: 1 }]);
    // No separate event kind for the ui-quality case: `quality.repair_requested`
    // driven purely by `approved: false`, then `quality.approved` once the
    // second, passing report lands — the loop proceeds.
    expect(
      events.events
        .filter((event) => event.dedupeKey?.includes(':browser:'))
        .map((event) => ({ type: event.type, iteration: event.data.iteration })),
    ).toEqual([
      { type: 'quality.repair_requested', iteration: 1 },
      { type: 'quality.approved', iteration: 2 },
    ]);
    expect(
      events.events
        .filter((event) => event.type === 'task.completed')
        .map((event) => event.data.taskId),
    ).toEqual(['T1']);
  });

  it('derives a resumed attempt and executor from persisted failure evidence', async () => {
    const power = { on: true };
    const artifacts = new InMemoryArtifacts(power);
    const events = new InMemoryEvents(power);
    const stepRuns = new InMemoryStepRuns(power);
    const stepAttempts = new InMemoryStepAttempts(power);
    const workspaces = new FakeWorkspaces(power);
    const implementations: Array<{
      iteration: number | undefined;
      routingStartIndex: number | undefined;
    }> = [];
    await putTaskGraph(artifacts, [task('T1')]);
    await events.append({
      id: 'event-1',
      projectId: project.id,
      type: 'task.failed',
      createdAt: '2026-08-07T12:00:00.000Z',
      nodeId: 'task-execution',
      runId: 'run-1',
      message: 'T1 attempt 1/2 failed.',
      data: { taskId: 'T1', stepId: 'implement.T1', attempt: 1 },
    });
    await stepRuns.create({
      id: 'step-run-1',
      runId: 'run-1',
      nodeId: 'task-execution',
      stepId: 'implement.T1',
      stepType: 'agent',
      iteration: 1,
      status: 'completed',
      version: 1,
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:01.000Z',
      startedAt: '2026-08-07T12:00:00.000Z',
      completedAt: '2026-08-07T12:00:01.000Z',
    });
    await stepAttempts.create({
      id: 'attempt-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      sequence: 1,
      executorKind: 'agent',
      provider: 'claude',
      model: 'claude-sonnet',
      status: 'succeeded',
      version: 1,
      createdAt: '2026-08-07T12:00:00.000Z',
      updatedAt: '2026-08-07T12:00:01.000Z',
      startedAt: '2026-08-07T12:00:00.000Z',
      completedAt: '2026-08-07T12:00:01.000Z',
      checkpoint: 'checkpoint-1',
      context: {
        projectId: project.id,
        workflowId: retryWorkflow.id,
        nodeId: 'task-execution',
        stepId: 'implement.T1',
        iteration: 1,
      },
      inputArtifacts: [],
      outputArtifacts: [],
    });

    const runtime: TaskGraphRuntime = {
      async executeStep(input: TaskGraphStepExecution): Promise<StoredArtifact> {
        if (input.step.id === 'implement.T1') {
          implementations.push({
            iteration: input.iteration,
            routingStartIndex: input.routingStartIndex,
          });
        }
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content:
            input.step.type === 'verify' ? verificationReport(true) : completedArtifact(input.step),
          createdBy: 'test-runtime',
        });
      },
      assertExecutionMayContinue: () => Promise.resolve(),
      isControlFlowError: () => false,
      recordDeterministicOutcome: () => Promise.resolve(),
      recordCompletedRepair: () => Promise.resolve(),
      resetConsecutiveRepairs: () => Promise.resolve(),
    };
    const runner = new TaskGraphRunner({
      artifacts,
      events,
      stepRuns,
      stepAttempts,
      workspaces,
      clock: new SystemClock(),
      ids: new SequentialIds(),
      runtime,
    });
    const node = retryWorkflow.nodes[0];
    if (node?.type !== 'for-each-task') throw new Error('Expected for-each-task fixture');

    await runner.run({
      project,
      workflow: retryWorkflow,
      node,
      runId: 'run-1',
      signal: new AbortController().signal,
    });

    expect(implementations).toEqual([{ iteration: 2, routingStartIndex: 1 }]);
    expect(workspaces.rollbacks[0]).toBe('checkpoint-1');
  });

  it('rejects an unavailable browser acceptance channel before starting a task', async () => {
    const power = { on: true };
    const artifacts = new InMemoryArtifacts(power);
    const events = new InMemoryEvents(power);
    let executions = 0;
    await putTaskGraph(artifacts, [{ ...task('T1'), acceptanceMode: 'browser-visible' }]);
    const runtime: TaskGraphRuntime = {
      executeStep: () => {
        executions += 1;
        return Promise.reject(new Error('Task execution must not start'));
      },
      assertExecutionMayContinue: () => Promise.resolve(),
      isControlFlowError: () => false,
      recordDeterministicOutcome: () => Promise.resolve(),
      recordCompletedRepair: () => Promise.resolve(),
      resetConsecutiveRepairs: () => Promise.resolve(),
    };
    const runner = new TaskGraphRunner({
      artifacts,
      events,
      stepRuns: new InMemoryStepRuns(power),
      stepAttempts: new InMemoryStepAttempts(power),
      workspaces: new FakeWorkspaces(power),
      clock: new SystemClock(),
      ids: new SequentialIds(),
      runtime,
    });
    const node = workflow.nodes[0];
    if (node?.type !== 'for-each-task') throw new Error('Expected for-each-task fixture');

    await expect(
      runner.run({
        project,
        workflow,
        node,
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      'Task T1 declares browser-visible acceptance, but the workflow has no browser assertion channel',
    );
    expect(executions).toBe(0);
    expect(events.events).toEqual([]);
  });

  it('does not create a task-level retry for an executor failure', async () => {
    let executions = 0;
    const fixture = await setupRunner(workflow, [task('T1')], () => {
      executions += 1;
      return Promise.reject(new Error('provider failed'));
    });

    await expect(fixture.run()).rejects.toThrow('provider failed');

    expect(executions).toBe(1);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'task.failed')
        .map((event) => event.data.attempt),
    ).toEqual([1]);
    expect(fixture.workspaces.rollbacks).toEqual(['initial-head']);
  });

  it('fails when a red gate exhausts the declared executor ladder', async () => {
    let implementations = 0;
    const fixture = await setupRunner(singleExecutorWorkflow, [task('T1')], (input, artifacts) => {
      if (input.step.id === 'implement.T1') implementations += 1;
      return artifacts.put({
        projectId: input.project.id,
        name: input.step.outputArtifact,
        content:
          input.step.type === 'verify' ? verificationReport(false) : completedArtifact(input.step),
        createdBy: 'test-runtime',
      });
    });

    await expect(fixture.run()).rejects.toThrow('exhausted its executor ladder');

    expect(implementations).toBe(1);
    expect(fixture.events.events.filter((event) => event.type === 'task.failed')).toHaveLength(1);
  });

  it('fails the attempt when the implement agent reports blocked (#537)', async () => {
    // A `blocked` implement artifact never touched the workspace — it must
    // not sail through verification and complete the task with no
    // deliverable produced.
    const fixture = await setupRunner(workflow, [task('T1')], (input, artifacts) =>
      artifacts.put({
        projectId: input.project.id,
        name: input.step.outputArtifact,
        content: blockedArtifact('Needs the payments API key, which is not in the workspace.'),
        createdBy: 'test-runtime',
      }),
    );

    await expect(fixture.run()).rejects.toThrow(
      'Needs the payments API key, which is not in the workspace.',
    );

    expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
      0,
    );
    const failed = fixture.events.events.find((event) => event.type === 'task.failed');
    expect(failed?.message).toContain('Needs the payments API key, which is not in the workspace.');
    // Machine-readable discriminator mirroring #528's `infrastructureFailure`
    // field: a consumer branches on `data.blockedReason` instead of
    // regexing the human-readable message.
    expect(failed?.data.blockedReason).toBe(
      'Needs the payments API key, which is not in the workspace.',
    );
  });

  it('retries a blocked implement attempt on the next executor and still completes (#537)', async () => {
    // The guard must not break the existing attempt ladder: a blocked first
    // attempt rolls back and retries on the next executor exactly like any
    // other quality-gate failure.
    let implementations = 0;
    const fixture = await setupRunner(retryWorkflow, [task('T1')], (input, artifacts) => {
      const content =
        input.step.type === 'verify'
          ? verificationReport(true)
          : input.step.id === 'implement.T1'
            ? (implementations += 1) === 1
              ? blockedArtifact('First executor cannot proceed.')
              : completedArtifact(input.step)
            : completedArtifact(input.step);
      return artifacts.put({
        projectId: input.project.id,
        name: input.step.outputArtifact,
        content,
        createdBy: 'test-runtime',
      });
    });

    await fixture.run();

    expect(implementations).toBe(2);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'task.failed')
        .map((event) => event.data.attempt),
    ).toEqual([1]);
    expect(
      fixture.events.events.find((event) => event.type === 'task.completed')?.data.attempt,
    ).toBe(2);
  });

  it('fails the attempt when the verify-repair agent reports blocked (#537)', async () => {
    const fixture = await setupRunner(gatedWorkflow, [task('T1')], (input, artifacts) => {
      const content =
        input.step.type === 'verify'
          ? verificationReport(false)
          : input.step.id === 'repair-task.T1'
            ? blockedArtifact('Cannot fix without secrets access.')
            : completedArtifact(input.step);
      return artifacts.put({
        projectId: input.project.id,
        name: input.step.outputArtifact,
        content,
        createdBy: 'test-runtime',
      });
    });

    await expect(fixture.run()).rejects.toThrow('Cannot fix without secrets access.');

    expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
      0,
    );
    const failed = fixture.events.events.find((event) => event.type === 'task.failed');
    expect(failed?.data.blockedReason).toBe('Cannot fix without secrets access.');
  });

  it('runs the browser channel only for browser-visible tasks', async () => {
    const browserPlans: string[] = [];
    const fixture = await setupRunner(
      browserWorkflow,
      [task('T1'), { ...task('T2', ['T1']), acceptanceMode: 'browser-visible' }],
      (input, artifacts) => {
        let content: object = completedArtifact(input.step);
        if (input.step.id.startsWith('verify-task.')) content = verificationReport(true);
        if (input.step.id.startsWith('plan-task-browser-test.')) {
          browserPlans.push(input.step.id);
          content = browserPlan();
        }
        if (input.step.id.startsWith('assert-task.')) content = browserReport(true);
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await fixture.run();

    expect(browserPlans).toEqual(['plan-task-browser-test.T2']);
  });

  it('fails a browser-visible task when its plan refuses the assertion', async () => {
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts) =>
        artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content:
            input.step.type === 'verify'
              ? verificationReport(true)
              : input.step.id === 'plan-task-browser-test.T1'
                ? blockedArtifact()
                : completedArtifact(input.step),
          createdBy: 'test-runtime',
        }),
    );

    await expect(fixture.run()).rejects.toThrow('browser plan refused the assertion');
    expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
      0,
    );
  });

  it('completes a task whose browser plan blocks assertion outside browser-visible acceptance (#537)', async () => {
    // #537's guard must not reach the browser *plan* step: "blocked" there
    // is a valid "nothing to assert" answer (see taskBrowserPlanStep's
    // prompt), not a failed attempt — existing behaviour this fix must keep
    // green.
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: undefined }],
      (input, artifacts) => {
        const content =
          input.step.type === 'verify'
            ? verificationReport(true)
            : input.step.id === 'plan-task-browser-test.T1'
              ? blockedArtifact()
              : completedArtifact(input.step);
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await fixture.run();

    expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
      1,
    );
    expect(fixture.events.events.some((event) => event.type === 'task.failed')).toBe(false);
  });

  it('rejects a malformed browser plan without spending the repair budget', async () => {
    let repairs = 0;
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts) => {
        if (input.step.id === 'repair-task-browser.T1') repairs += 1;
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content:
            input.step.type === 'verify' ? verificationReport(true) : completedArtifact(input.step),
          createdBy: 'test-runtime',
        });
      },
    );

    await expect(fixture.run()).rejects.toThrow(
      'produced neither a valid browser test plan nor a "blocked" answer',
    );
    expect(repairs).toBe(0);
  });

  it('fails an infrastructure-unreachable browser check without spending the repair budget', async () => {
    let repairs = 0;
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts) => {
        if (input.step.id === 'repair-task-browser.T1') repairs += 1;
        let content: object = completedArtifact(input.step);
        if (input.step.id === 'verify-task.T1') content = verificationReport(true);
        else if (input.step.id === 'plan-task-browser-test.T1') content = browserPlan();
        else if (input.step.id === 'assert-task.T1') content = infrastructureFailureBrowserReport();
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await expect(fixture.run()).rejects.toThrow(
      /browser verification never reached the app.*ECONNREFUSED 127\.0\.0\.1:4000/s,
    );

    expect(repairs).toBe(0);
    expect(
      fixture.events.events.filter((event) => event.type === 'quality.repair_requested'),
    ).toHaveLength(0);
    const failed = fixture.events.events.find((event) => event.type === 'task.failed');
    expect(failed?.message).toContain('ECONNREFUSED 127.0.0.1:4000');
    // Machine-readable discriminator (#528 review): a consumer must be able
    // to branch on `data.infrastructureFailure` instead of regexing the
    // human-readable message, which is free to reword.
    expect(failed?.data.infrastructureFailure).toBe(
      'Preview at http://127.0.0.1:4000 is unreachable: route.fetch: connect ECONNREFUSED 127.0.0.1:4000',
    );
  });

  it('still enters repair for a browser check that is merely unapproved, not infrastructure-broken', async () => {
    // #528's other direction: `approved: false` with no `infrastructureFailure`
    // must not be mistaken for a harness failure — the repair loop runs
    // exactly as it does today.
    let repairs = 0;
    let browserChecks = 0;
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts) => {
        if (input.step.id === 'repair-task-browser.T1') repairs += 1;
        let content: object = completedArtifact(input.step);
        if (input.step.id === 'verify-task.T1') content = verificationReport(true);
        else if (input.step.id === 'plan-task-browser-test.T1') content = browserPlan();
        else if (input.step.id === 'assert-task.T1') {
          browserChecks += 1;
          content = browserReport(browserChecks > 1);
        }
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await fixture.run();

    expect(repairs).toBe(1);
    expect(
      fixture.events.events
        .filter((event) => event.type === 'quality.repair_requested')
        .map((event) => event.data.taskId),
    ).toEqual(['T1']);
    // Rules out the new infrastructure-failure branch, rather than just
    // asserting the ordinary repair path ran: no failure and no marker.
    expect(fixture.events.events.some((event) => event.type === 'task.failed')).toBe(false);
    expect(
      fixture.events.events.every((event) => event.data.infrastructureFailure === undefined),
    ).toBe(true);
  });

  it('rolls a browser startup failure back to the verified implementation', async () => {
    const fixture = await setupRunner(
      browserWorkflow,
      [{ ...task('T1'), acceptanceMode: 'browser-visible' }],
      (input, artifacts, stores) => {
        if (input.step.id === 'implement.T1') stores.workspaces.touch();
        if (input.step.id === 'assert-task.T1') {
          return Promise.reject(new Error('Browser verification is not configured'));
        }
        let content: object = completedArtifact(input.step);
        if (input.step.id === 'verify-task.T1') content = verificationReport(true);
        if (input.step.id === 'plan-task-browser-test.T1') content = browserPlan();
        return artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content,
          createdBy: 'test-runtime',
        });
      },
    );

    await expect(fixture.run()).rejects.toThrow('Browser verification is not configured');

    expect(fixture.workspaces.current).toBe('sha-0001');
    expect(fixture.workspaces.rollbacks).toContain('sha-0001');
  });

  describe('bounded parallel frontier (#520)', () => {
    it('touches no worktree and records no parallelism at the default cap', async () => {
      const fixture = await setupRunner(workflow, [task('T1'), task('T2')], (input, artifacts) =>
        artifacts.put({
          projectId: input.project.id,
          name: input.step.outputArtifact,
          content: completedArtifact(input.step),
          createdBy: 'test-runtime',
        }),
      );

      await fixture.run();

      expect(fixture.workspaces.worktreeOps).toEqual([]);
      expect(
        fixture.events.events
          .filter((event) => event.type === 'task.started')
          .map((event) => event.data.parallelism),
      ).toEqual([undefined, undefined]);
    });

    it('starts every independent task before any of them completes', async () => {
      const gate = arrivalGate(3);
      const startedTasks: string[] = [];
      const fixture = await setupRunner(
        workflow,
        [task('T1'), task('T2'), task('T3')],
        async (input, artifacts) => {
          startedTasks.push(taskIdOf(input.step.id));
          await gate.arrive();
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        3,
      );

      await fixture.run();

      // The gate only opens once three callers are inside it, so this is
      // three tasks genuinely in flight at the same moment, not three
      // sequential starts observed after the fact.
      expect(gate.arrivalsWhenOpened).toBe(3);
      expect([...startedTasks].sort()).toEqual(['T1', 'T2', 'T3']);
      expect(
        fixture.events.events
          .filter((event) => event.type === 'task.started')
          .map((event) => event.data.parallelism),
      ).toEqual([3, 3, 3]);
      expect(fixture.workspaces.liveWorktrees.size).toBe(0);
    });

    it('never runs more tasks at once than the cap allows', async () => {
      const concurrency = concurrencyMeter();
      const fixture = await setupRunner(
        workflow,
        ['T1', 'T2', 'T3', 'T4', 'T5'].map((id) => task(id)),
        async (input, artifacts) => {
          const done = concurrency.enter();
          await yieldToTimers();
          done();
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        2,
      );

      await fixture.run();

      expect(concurrency.peak).toBe(2);
      expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
        5,
      );
    });

    it('clamps a cap above the supported ceiling instead of trusting its caller', async () => {
      const concurrency = concurrencyMeter();
      const fixture = await setupRunner(
        workflow,
        Array.from({ length: 12 }, (_value, index) => task(`T${index + 1}`)),
        async (input, artifacts) => {
          const done = concurrency.enter();
          await yieldToTimers();
          done();
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        99,
      );

      await fixture.run();

      expect(concurrency.peak).toBe(8);
    });

    it('holds a dependent task back until its blocker has completed', async () => {
      const completedWhenStarted = new Map<string, string[]>();
      const fixture = await setupRunner(
        workflow,
        [task('T1'), task('T2', ['T1']), task('T3')],
        async (input, artifacts, stores) => {
          completedWhenStarted.set(
            taskIdOf(input.step.id),
            stores.workspaces.worktreeOps
              .filter((operation) => operation.startsWith('integrate:'))
              .map((operation) => taskIdOf(operation)),
          );
          await yieldToTimers();
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        3,
      );

      await fixture.run();

      // T2 may only start once T1 has already merged back; T3 has no blocker
      // and starts against an empty frontier alongside T1.
      expect(completedWhenStarted.get('T2')).toContain('T1');
      expect(completedWhenStarted.get('T1')).toEqual([]);
      expect(completedWhenStarted.get('T3')).toEqual([]);
    });

    it('merges one worktree into the primary checkout at a time', async () => {
      const merges = concurrencyMeter();
      const fixture = await setupRunner(
        workflow,
        [task('T1'), task('T2'), task('T3')],
        async (input, artifacts) => {
          await yieldToTimers();
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        3,
      );
      fixture.workspaces.onIntegrateWorktree = async () => {
        const done = merges.enter();
        await yieldToTimers();
        done();
      };

      await fixture.run();

      expect(merges.peak).toBe(1);
      expect(merges.entries).toBe(3);
    });

    it('fails only the conflicting task when integration cannot merge, and retries it', async () => {
      let conflicts = 0;
      const fixture = await setupRunner(
        retryWorkflow,
        [task('T1'), task('T2')],
        (input, artifacts) =>
          artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content:
              input.step.type === 'verify'
                ? verificationReport(true)
                : completedArtifact(input.step),
            createdBy: 'test-runtime',
          }),
        2,
      );
      fixture.workspaces.onIntegrateWorktree = (label) => {
        if (!label.endsWith('T2') || conflicts > 0) return;
        conflicts += 1;
        throw new ExecutionError(`Failed to integrate worktree "${label}": CONFLICT (content)`);
      };

      await fixture.run();

      expect(conflicts).toBe(1);
      // The conflict is one failed attempt of T2, not a failed run: T1 lands
      // untouched and T2's existing attempt ladder retries it.
      expect(
        fixture.events.events
          .filter((event) => event.type === 'task.failed')
          .map((event) => ({ taskId: event.data.taskId, attempt: event.data.attempt })),
      ).toEqual([{ taskId: 'T2', attempt: 1 }]);
      expect(
        fixture.events.events
          .filter((event) => event.type === 'task.completed')
          .map((event) => ({ taskId: event.data.taskId, attempt: event.data.attempt }))
          .sort((left, right) => String(left.taskId).localeCompare(String(right.taskId))),
      ).toEqual([
        { taskId: 'T1', attempt: 1 },
        { taskId: 'T2', attempt: 2 },
      ]);
      // The retry re-forks from the primary, so it re-plans against the tree
      // its conflicting sibling has already landed in.
      expect(
        fixture.workspaces.worktreeOps.filter((operation) => operation.endsWith('T2')),
      ).toEqual([
        'create:run-1-task-execution-T2',
        'integrate:run-1-task-execution-T2',
        'create:run-1-task-execution-T2',
        'integrate:run-1-task-execution-T2',
        'remove:run-1-task-execution-T2',
      ]);
      expect(fixture.workspaces.liveWorktrees.size).toBe(0);
    });

    it('never runs a browser-visible task alongside another task', async () => {
      const active = new Set<string>();
      const companions = new Set<string>();
      const fixture = await setupRunner(
        browserWorkflow,
        [task('T1'), { ...task('T2'), acceptanceMode: 'browser-visible' }, task('T3')],
        async (input, artifacts) => {
          const taskId = taskIdOf(input.step.id);
          active.add(taskId);
          if (taskId === 'T2') {
            for (const other of active) if (other !== 'T2') companions.add(other);
          } else if (active.has('T2')) {
            companions.add(taskId);
          }
          await yieldToTimers();
          active.delete(taskId);
          let content: object = completedArtifact(input.step);
          if (input.step.id.startsWith('verify-task.')) content = verificationReport(true);
          if (input.step.id.startsWith('plan-task-browser-test.')) content = browserPlan();
          if (input.step.id.startsWith('assert-task.')) content = browserReport(true);
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content,
            createdBy: 'test-runtime',
          });
        },
        3,
      );

      await fixture.run();

      expect([...companions]).toEqual([]);
      // A browser-visible task drives a preview session bound to the primary
      // checkout, so it runs there with no worktree of its own.
      expect(fixture.workspaces.worktreeOps.some((operation) => operation.endsWith('T2'))).toBe(
        false,
      );
      expect(fixture.events.events.filter((event) => event.type === 'task.completed')).toHaveLength(
        3,
      );
    });

    it('removes every worktree when a task fails, and lets its siblings settle', async () => {
      const settled: string[] = [];
      const fixture = await setupRunner(
        workflow,
        [task('T1'), task('T2')],
        async (input, artifacts) => {
          const taskId = taskIdOf(input.step.id);
          await yieldToTimers();
          if (taskId === 'T1') {
            settled.push('T1');
            throw new Error('provider failed');
          }
          settled.push('T2');
          return artifacts.put({
            projectId: input.project.id,
            name: input.step.outputArtifact,
            content: completedArtifact(input.step),
            createdBy: 'test-runtime',
          });
        },
        2,
      );

      await expect(fixture.run()).rejects.toThrow('provider failed');

      expect([...settled].sort()).toEqual(['T1', 'T2']);
      expect(fixture.workspaces.liveWorktrees.size).toBe(0);
      expect(
        fixture.workspaces.worktreeOps
          .filter((operation) => operation.startsWith('remove:'))
          .sort(),
      ).toEqual(['remove:run-1-task-execution-T1', 'remove:run-1-task-execution-T2']);
    });
  });
});

/**
 * Opens once `count` callers are simultaneously inside it, so a test can prove
 * real concurrency instead of inferring it from timing. The timeout is a
 * failure valve, not a schedule: if the pool serializes, the gate opens with
 * fewer arrivals and `arrivalsWhenOpened` fails the assertion rather than
 * hanging until vitest's own timeout.
 */
function arrivalGate(
  count: number,
  timeoutMs = 500,
): { arrive: () => Promise<void>; readonly arrivalsWhenOpened: number } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let arrivals = 0;
  let arrivalsWhenOpened = 0;
  const timer = setTimeout(() => {
    arrivalsWhenOpened = arrivals;
    open();
  }, timeoutMs);
  return {
    async arrive(): Promise<void> {
      arrivals += 1;
      if (arrivals >= count) {
        arrivalsWhenOpened = arrivals;
        clearTimeout(timer);
        open();
      }
      await opened;
    },
    get arrivalsWhenOpened(): number {
      return arrivalsWhenOpened;
    },
  };
}

/** High-water mark of a critical section, for "the cap held" assertions. */
function concurrencyMeter(): {
  enter: () => () => void;
  readonly peak: number;
  readonly entries: number;
} {
  let active = 0;
  let peak = 0;
  let entries = 0;
  return {
    enter(): () => void {
      active += 1;
      entries += 1;
      peak = Math.max(peak, active);
      return () => {
        active -= 1;
      };
    },
    get peak(): number {
      return peak;
    },
    get entries(): number {
      return entries;
    },
  };
}

/** Yields past the microtask queue so pending work can genuinely interleave. */
function yieldToTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** `implement.T1` / `integrate:run-1-task-execution-T1` -> `T1`. */
function taskIdOf(value: string): string {
  return (
    value
      .slice(value.lastIndexOf('.') + 1)
      .split('-')
      .at(-1) ?? value
  );
}

async function setupRunner(
  workflowDefinition: WorkflowDefinition,
  tasks: PlanTask[],
  executeStep: (
    input: TaskGraphStepExecution,
    artifacts: InMemoryArtifacts,
    stores: {
      stepAttempts: InMemoryStepAttempts;
      workspaces: FakeWorkspaces;
    },
  ) => Promise<StoredArtifact>,
  maxParallelTasks?: number,
): Promise<{
  run: () => Promise<StoredArtifact>;
  events: InMemoryEvents;
  stepAttempts: InMemoryStepAttempts;
  workspaces: FakeWorkspaces;
}> {
  const power = { on: true };
  const artifacts = new InMemoryArtifacts(power);
  const events = new InMemoryEvents(power);
  const stepAttempts = new InMemoryStepAttempts(power);
  const workspaces = new FakeWorkspaces(power);
  await putTaskGraph(artifacts, tasks);
  const runtime: TaskGraphRuntime = {
    executeStep: (input) => executeStep(input, artifacts, { stepAttempts, workspaces }),
    assertExecutionMayContinue: () => Promise.resolve(),
    isControlFlowError: () => false,
    recordDeterministicOutcome: () => Promise.resolve(),
    recordCompletedRepair: () => Promise.resolve(),
    resetConsecutiveRepairs: () => Promise.resolve(),
  };
  const runner = new TaskGraphRunner({
    artifacts,
    events,
    stepRuns: new InMemoryStepRuns(power),
    stepAttempts,
    workspaces,
    clock: new SystemClock(),
    ids: new SequentialIds(),
    runtime,
    ...(maxParallelTasks !== undefined ? { maxParallelTasks } : {}),
  });
  const node = workflowDefinition.nodes[0];
  if (node?.type !== 'for-each-task') throw new Error('Expected for-each-task fixture');
  return {
    run: () =>
      runner.run({
        project,
        workflow: workflowDefinition,
        node,
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    events,
    stepAttempts,
    workspaces,
  };
}

function task(id: string, dependsOn: string[] = [], title = `${id} task`): PlanTask {
  return {
    id,
    title,
    dependsOn,
    deliverables: [`src/${id.toLowerCase()}.ts`],
    acceptanceCheck: `${id} passes.`,
    acceptanceMode: 'deterministic-only',
  };
}

async function putTaskGraph(artifacts: InMemoryArtifacts, tasks: PlanTask[]): Promise<void> {
  await artifacts.put({
    projectId: project.id,
    name: 'plan.current',
    content: {
      schemaVersion: '1',
      status: 'completed',
      summary: `${tasks.length} task(s).`,
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
      data: { schemaVersion: '1', tasks },
    },
    createdBy: 'test',
  });
}

function completedArtifact(step: ExecutableStep): object {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: `${step.id} completed.`,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
    data: {},
  };
}

function verificationReport(approved: boolean): object {
  return {
    schemaVersion: '1',
    approved,
    packageManager: 'npm',
    summary: approved ? 'Checks passed.' : 'Checks failed.',
    commands: [],
    createdAt: '2026-08-07T12:00:00.000Z',
  };
}

function browserPlan(): object {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: 'Assert the task.',
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
    data: {
      schemaVersion: '1',
      id: 'task-plan',
      title: 'Task plan',
      viewport: { width: 1280, height: 720 },
      steps: [
        {
          id: 'open-root',
          title: 'Open root',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'url', path: '/' }],
        },
      ],
    },
  };
}

function browserReport(approved: boolean): object {
  return {
    schemaVersion: '1',
    approved,
    summary: approved ? 'Browser passed.' : 'Browser failed.',
    planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
    previewSession: {
      sessionId: 'preview-1',
      status: 'running',
      url: 'http://127.0.0.1:4000/',
      evidence: { screenshots: [] },
    },
    steps: [
      {
        stepId: 'open-root',
        title: 'Open root',
        status: approved ? 'passed' : 'failed',
        durationMs: 1,
        observations: [],
        ...(approved ? {} : { error: 'Root did not load.' }),
      },
    ],
  };
}

/**
 * A browser-verification report shaped like Task 1's `PlaywrightBrowserVerifier`
 * output when the preview origin itself could not be reached (#526/#528): the
 * harness never got far enough to run any assertion, so `infrastructureFailure`
 * is set alongside `approved: false`.
 */
function infrastructureFailureBrowserReport(): object {
  return {
    ...browserReport(false),
    infrastructureFailure:
      'Preview at http://127.0.0.1:4000 is unreachable: route.fetch: connect ECONNREFUSED 127.0.0.1:4000',
  };
}

/**
 * A browser-verification report shaped like Task 2's `gateOnUiQuality`
 * output (#477): every functional step `passed`, but `approved: false`
 * because the judge's `overallScore` fell below the configured threshold.
 * Constructed directly (not via `gateOnUiQuality`) — this test exercises
 * `task-graph-runner.ts`'s consumption of the field, not the gate function
 * itself, which Task 2's unit tests already cover in isolation.
 */
function uiQualityGatedBrowserReport(): object {
  return {
    ...browserReport(true),
    approved: false,
    summary:
      'Browser passed. UI-quality gate failed: overall score 0.40 is below the configured minimum 0.70.',
    uiQuality: {
      rubricVersion: '1',
      judgeModel: 'claude-test',
      overallScore: 0.4,
      criteria: [{ criterionId: 'layout', score: 0.4, finding: 'Cramped spacing.' }],
      screenshotsReviewed: [],
    },
  };
}

/**
 * The post-repair counterpart to `uiQualityGatedBrowserReport()`: same shape,
 * `approved: true`, and `uiQuality.overallScore` above the gate's implied
 * threshold — a real retry after repair would plausibly still carry a
 * `uiQuality` block, just passing.
 */
function passingUiQualityBrowserReport(): object {
  return {
    ...browserReport(true),
    uiQuality: {
      rubricVersion: '1',
      judgeModel: 'claude-test',
      overallScore: 0.8,
      criteria: [{ criterionId: 'layout', score: 0.8 }],
      screenshotsReviewed: [],
    },
  };
}

function blockedArtifact(summary = 'No browser surface.'): object {
  return {
    schemaVersion: '1',
    status: 'blocked',
    summary,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
    data: {},
  };
}
