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
import { SystemClock } from '@agent-foundry/domain';
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
});

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

function blockedArtifact(): object {
  return {
    schemaVersion: '1',
    status: 'blocked',
    summary: 'No browser surface.',
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
    data: {},
  };
}
