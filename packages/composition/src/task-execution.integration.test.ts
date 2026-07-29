import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  BrowserVerificationReport,
  ExecutorHealth,
  PlanTask,
  ProjectEvent,
  VerificationCommandResult,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { MockAgentExecutor } from '@agent-foundry/executors';
import { createRuntime, type Runtime } from './runtime.js';
import { approveAllGates } from './testing-helpers.js';

/**
 * PRD → plan → operator approval → per-task execution. Deliberately stops
 * short of the browser assertion (#325); the deterministic gate below is the
 * seam that proves the loop itself.
 */
const TASK_LOOP_WORKFLOW = `
schemaVersion: '1'
id: task-loop-v1
name: Task loop fixture
description: Plans a task graph, waits for approval, then implements task by task.
stack: nextjs
nodes:
  - id: plan
    type: agent
    role: planner
    taskKind: planning
    title: Turn the PRD into a task graph
    instructions: Decompose the PRD into a dependency-aware task graph.
    inputArtifacts: [prd]
    outputArtifact: plan.current
    outputContract: task-graph
    mutatesWorkspace: false

  - id: plan-approval
    type: approval-gate
    title: Operator plan approval
    artifact: plan.current
    outputArtifact: plan.approval

  - id: task-execution
    type: for-each-task
    title: Implement the approved task graph
    taskGraphArtifact: plan.current
    implement:
      id: implement
      type: agent
      role: developer
      taskKind: implementation
      title: Implement one planned task
      instructions: Implement exactly the task described below.
      inputArtifacts: [prd, plan.current]
      outputArtifact: implementation.report
      mutatesWorkspace: true
      maxAttempts: 2
`;

/** The same fixture with the per-task deterministic gate wired in (#324). */
const GATED_TASK_LOOP_WORKFLOW = `${TASK_LOOP_WORKFLOW}    verify:
      id: verify-task
      type: verify
      title: Run the task's deterministic checks
      outputArtifact: verification.report
      scripts: [typecheck]
      optionalScripts: [lint, test, 'db:reset']
      includeGitDiffCheck: true
    repair:
      id: repair-task
      type: agent
      role: fixer
      taskKind: repair
      title: Repair the failing checks
      instructions: Read the failed command output and fix its root cause.
      inputArtifacts: [verification.report]
      outputArtifact: verification.fix
      mutatesWorkspace: true
      maxAttempts: 1
`;

/** A ladder longer than the three configured vendors, for exhaustion coverage. */
const EXHAUSTING_GATED_TASK_LOOP_WORKFLOW = GATED_TASK_LOOP_WORKFLOW.replace(
  'maxAttempts: 2',
  'maxAttempts: 4',
);

/** The gated fixture plus the per-task browser assertion (#325). */
const ASSERTED_TASK_LOOP_WORKFLOW = `${GATED_TASK_LOOP_WORKFLOW}    browser:
      plan:
        id: plan-task-browser-test
        type: agent
        role: tester
        taskKind: verification
        title: Turn the acceptance check into a browser plan
        instructions: Produce a declarative browser test plan for this task's acceptance check.
        inputArtifacts: [prd]
        outputArtifact: browser-test.plan
        mutatesWorkspace: false
      check:
        id: assert-task
        type: verify
        title: Assert the acceptance check in a browser
        outputArtifact: browser-verification.report
        browserTestPlanArtifact: browser-test.plan
        scripts: []
        includeGitDiffCheck: false
`;

function task(id: string, dependsOn: string[] = []): PlanTask {
  return {
    id,
    title: `${id} work`,
    dependsOn,
    deliverables: [`src/${id}.ts`],
    acceptanceCheck: `${id} behaves`,
  };
}

interface TaskGraphExecutorOptions {
  /** Exactly the graph the planner emits. */
  tasks: PlanTask[];
  /** Requests that fail instead of running. */
  fail?: (request: AgentExecutionRequest) => boolean;
  /** Runs after a successful step — where a test pauses the run mid-graph. */
  onStep?: (request: AgentExecutionRequest) => Promise<void>;
  /** Steps that leave the workspace failing `typecheck` rather than passing it. */
  corrupt?: (request: AgentExecutionRequest) => boolean;
  /** Tasks whose browser-plan step reports no user-visible surface to assert. */
  noBrowserSurface?: (request: AgentExecutionRequest) => boolean;
  /** Plan steps that return neither a valid plan nor a "blocked" answer. */
  malformedPlan?: (request: AgentExecutionRequest) => boolean;
}

/** Mock executor with the knobs the loop's tests need. No model is called. */
class TaskGraphExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private readonly delegate = new MockAgentExecutor();
  readonly executedSteps: string[] = [];

  constructor(private readonly options: TaskGraphExecutorOptions) {}

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    this.executedSteps.push(request.stepId);
    if (this.options.fail?.(request)) {
      throw new Error(`synthetic failure in ${request.stepId}`);
    }
    const result = await this.delegate.execute(request, signal);
    // The mock rewrites src/index.js on every mutating step, so appending
    // after it is what leaves a real, reproducible `node --check` failure for
    // the deterministic gate to catch — and the next mutating step to clear.
    if (this.options.corrupt?.(request)) {
      await appendFile(join(request.cwd, 'src', 'index.js'), 'export function broken( {\n');
    }
    await this.options.onStep?.(request);
    if (this.options.malformedPlan?.(request)) {
      const output = { ...result.output, data: { nonsense: true } };
      return { ...result, output, stdout: JSON.stringify(output) };
    }
    if (this.options.noBrowserSurface?.(request)) {
      // How a task declares it has nothing a browser can assert.
      const output = {
        ...result.output,
        status: 'blocked' as const,
        summary: 'No user-visible surface for this task.',
        data: {},
      };
      return { ...result, output, stdout: JSON.stringify(output) };
    }
    if (request.stepId !== 'plan') return result;
    const output = {
      ...result.output,
      data: { schemaVersion: '1' as const, goal: 'Fixture plan', tasks: this.options.tasks },
    };
    return { ...result, output, stdout: JSON.stringify(output) };
  }

  health(): Promise<ExecutorHealth> {
    return this.delegate.health();
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTaskLoopRuntime(
  name: string,
  executor: AgentExecutor,
  workflow: string = TASK_LOOP_WORKFLOW,
): Promise<Runtime> {
  const dataDir = await mkdtemp(join(tmpdir(), `agent-foundry-${name}-data-`));
  const workflowsDir = await mkdtemp(join(tmpdir(), `agent-foundry-${name}-workflows-`));
  temporaryDirectories.push(dataDir, workflowsDir);
  await writeFile(join(workflowsDir, 'task-loop-v1.yaml'), workflow, 'utf8');
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: `${name}-worker`,
  });
  Object.defineProperty(runtime.executors, 'executor', { value: executor, configurable: true });
  return runtime;
}

async function startProject(
  runtime: Runtime,
  name: string,
): Promise<{ id: string; runId: string }> {
  const project = await runtime.projectService.create({
    name,
    workflowId: 'task-loop-v1',
    prd: 'Build a small issue tracker with create and complete flows and deterministic tests.',
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  return { id: project.id, runId: project.currentRunId };
}

/** Every commit subject in the workspace, oldest first. */
async function allCommits(runtime: Runtime, projectId: string): Promise<string[]> {
  const log = await execa('git', ['log', '--format=%s'], {
    cwd: runtime.workspaces.workspacePath(projectId),
  });
  return log.stdout.split('\n').reverse();
}

/** Commit subjects the implement step produced, oldest first. */
async function taskCommits(runtime: Runtime, projectId: string): Promise<string[]> {
  return (await allCommits(runtime, projectId)).filter((subject) =>
    subject.startsWith('agent(developer):'),
  );
}

/**
 * A preview that always starts and a browser verifier that answers from a
 * script, so the loop's logic is tested without a real browser (#325).
 * `verdicts` is consumed per assertion attempt; anything past its end passes.
 */
function stubBrowser(runtime: Runtime, verdicts: boolean[] = []): { attempts: number } {
  const state = { attempts: 0 };
  // The coordinator, not the Playwright verifier under it: mock mode already
  // swaps in an auto-approving coordinator, so stubbing the verifier would
  // never be consulted and every assertion would silently pass.
  Object.defineProperty(runtime.browserVerification, 'verify', {
    configurable: true,
    value: async (
      input: { plan: { metadata: { name: string; revision: number; sha256: string } } },
      _signal: AbortSignal,
      onSessionStarted?: (sessionId: string) => Promise<void>,
    ) => {
      const passed = verdicts[state.attempts] ?? true;
      state.attempts += 1;
      // The orchestrator binds the report to the session the coordinator
      // announced; without this it rejects the report as unsourced.
      const sessionId = `preview-${state.attempts}`;
      await onSessionStarted?.(sessionId);
      return {
        schemaVersion: '1',
        approved: passed,
        summary: passed ? 'Assertion passed.' : 'Assertion failed on the first step.',
        planArtifact: {
          name: input.plan.metadata.name,
          revision: input.plan.metadata.revision,
          sha256: input.plan.metadata.sha256,
        },
        previewSession: {
          sessionId,
          status: 'running',
          url: 'http://127.0.0.1:4000/preview/preview-1/',
          evidence: { screenshots: [] },
        },
        steps: [
          {
            stepId: 'open-root',
            title: 'Open the app',
            status: passed ? 'passed' : 'failed',
            durationMs: 12,
            observations: [],
            ...(passed ? {} : { error: 'expected the dashboard, got the sign-in page' }),
          },
        ],
      } satisfies BrowserVerificationReport;
    },
  });
  return state;
}

function taskEvents(events: ProjectEvent[], type: ProjectEvent['type']): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.data.taskId);
}

/** The loop's own events for one task, in order. */
function taskTimeline(events: ProjectEvent[], taskId: string): string[] {
  const loop = [
    'task.started',
    'task.completed',
    'task.failed',
    'quality.approved',
    'quality.repair_requested',
  ];
  return events
    .filter((event) => event.data.taskId === taskId && loop.includes(event.type))
    .map((event) => event.type);
}

describe('for-each-task execution', () => {
  it('runs each task in dependency order and commits it on its own', async () => {
    // Declaration order deliberately contradicts dependency order: T1 blocks on
    // T2, so a walker that ignores edges would run T1 first.
    const executor = new TaskGraphExecutor({
      tasks: [task('T1', ['T2']), task('T2'), task('T3', ['T1'])],
    });
    const runtime = await createTaskLoopRuntime('task-order', executor);
    const project = await startProject(runtime, 'Task order');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(taskEvents(detail.events, 'task.started')).toEqual(['T2', 'T1', 'T3']);
    expect(taskEvents(detail.events, 'task.completed')).toEqual(['T2', 'T1', 'T3']);
    expect(taskEvents(detail.events, 'task.failed')).toEqual([]);

    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T2: T2 work',
      'agent(developer): T1: T1 work',
      'agent(developer): T3: T3 work',
    ]);

    const stepRuns = await runtime.stepRuns.list(project.runId);
    expect(
      stepRuns.filter((step) => step.nodeId === 'task-execution').map((step) => step.stepId),
    ).toEqual(['implement.T2', 'implement.T1', 'implement.T3']);
    expect(stepRuns.every((step) => step.status === 'completed')).toBe(true);

    // One implementation.report revision per task, each bound to its own commit.
    const reports = await runtime.artifacts.listMetadata(project.id, 'implementation.report');
    expect(reports).toHaveLength(3);
    const completions = detail.events.filter((event) => event.type === 'task.completed');
    expect(new Set(completions.map((event) => event.data.commit)).size).toBe(3);
  }, 60_000);

  it('keeps completed tasks committed when a later task exhausts its executor fallbacks', async () => {
    const executor = new TaskGraphExecutor({
      tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T2'])],
      fail: (request) => request.stepId === 'implement.T2',
    });
    const runtime = await createTaskLoopRuntime('task-failure', executor);
    const project = await startProject(runtime, 'Task failure');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('failed');
    expect(detail.project.error).toContain('synthetic failure in implement.T2');

    // Convergence: T1's commit survives its successor's failure, and T3 — which
    // depends on T2 — never starts.
    expect(await taskCommits(runtime, project.id)).toEqual(['agent(developer): T1: T1 work']);
    expect(taskEvents(detail.events, 'task.completed')).toEqual(['T1']);
    expect(taskEvents(detail.events, 'task.started')).toEqual(['T1', 'T2']);

    // Provider/CLI failure exhausts the step's own fallback list. The task-level
    // ladder does not speculate before a red quality report exists.
    const failures = detail.events.filter((event) => event.type === 'task.failed');
    expect(failures.map((event) => event.data.attempt)).toEqual([1]);
    expect(failures.every((event) => event.data.maxAttempts === 2)).toBe(true);
    const attempts = (await runtime.stepRuns.list(project.runId)).filter(
      (step) => step.stepId === 'implement.T2',
    );
    expect(attempts.map((step) => step.iteration)).toEqual([1]);
    expect(attempts.every((step) => step.status === 'failed')).toBe(true);
    expect(executor.executedSteps.filter((step) => step === 'implement.T3')).toHaveLength(0);

    // Per-task, per-executor outcome (#326): which executor ran the task and
    // whether it succeeded or failed is on the event, not only inferable from
    // the attempt chain. This is the data a scored router could be fitted to.
    // `claude` because it heads the default table for `implementation` — the
    // fixture declares no table of its own, and attempt one takes the head.
    expect(
      detail.events.find((event) => event.type === 'task.completed' && event.data.taskId === 'T1')
        ?.data.executor,
    ).toBe('claude');
    // A failed task records the executor candidates walked within that one
    // implementation step; the task ladder is reserved for red quality gates.
    expect(failures[0]?.data.attemptedExecutors).toEqual(['claude', 'codex', 'agy']);
    expect(failures[0]?.data.executor).toBe('agy');
    expect(detail.events.find((event) => event.type === 'agent.routed')?.data).toMatchObject({
      table: 'default',
      selectedIndex: 0,
    });
  }, 60_000);

  it('resumes a paused graph at the first incomplete task', async () => {
    // The operator pauses while T1 is in flight; the run parks at the next step
    // boundary, which is T2.
    let pause: () => Promise<void> = async () => {};
    const executor = new TaskGraphExecutor({
      tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T2'])],
      onStep: async (request) => {
        if (request.stepId === 'implement.T1') await pause();
      },
    });
    const runtime = await createTaskLoopRuntime('task-pause', executor);
    const project = await startProject(runtime, 'Task pause');
    pause = async () => {
      await runtime.projectService.pauseRun(project.runId);
    };

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    expect((await runtime.runs.get(project.runId))?.status).toBe('paused');
    expect(await taskCommits(runtime, project.id)).toEqual(['agent(developer): T1: T1 work']);

    await runtime.projectService.resumeRun(project.runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    // T1 is not implemented twice: the resumed walk reuses its completed step.
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(1);
    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T1: T1 work',
      'agent(developer): T2: T2 work',
      'agent(developer): T3: T3 work',
    ]);
    expect(taskEvents(detail.events, 'task.completed')).toEqual(['T1', 'T2', 'T3']);
  }, 60_000);

  it('does not re-implement a task that a pause caught after a retried attempt', async () => {
    let pause: () => Promise<void> = async () => {};
    let firstAttempt = true;
    const executor = new TaskGraphExecutor({
      tasks: [task('T1'), task('T2', ['T1'])],
      corrupt: (request) => {
        if (request.stepId === 'implement.T1') return firstAttempt;
        if (request.stepId === 'repair-task.T1') {
          firstAttempt = false;
          return true;
        }
        return false;
      },
      onStep: async (request) => {
        if (request.stepId === 'implement.T2') await pause();
      },
    });
    const runtime = await createTaskLoopRuntime(
      'task-pause-retry',
      executor,
      GATED_TASK_LOOP_WORKFLOW,
    );
    const project = await startProject(runtime, 'Task pause after retry');
    pause = async () => {
      await runtime.projectService.pauseRun(project.runId);
    };

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);
    expect((await runtime.runs.get(project.runId))?.status).toBe('paused');

    // T1 failed its red quality gate on attempt 1, succeeded on attempt 2, and
    // the pause did not cause a third implementation.
    const completedT1 = (await runtime.projectService.get(project.id)).events.find(
      (event) => event.type === 'task.completed' && event.data.taskId === 'T1',
    );
    expect(completedT1?.data.attempt).toBe(2);
    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T1: T1 work',
      'agent(developer): T2: T2 work',
    ]);
    const executionsBeforeResume = executor.executedSteps.filter(
      (step) => step === 'implement.T1',
    ).length;

    await runtime.projectService.resumeRun(project.runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    // The resumed walk replays T1's succeeded attempt, not its failed first one:
    // no further execution, two step runs, and T1 committed exactly once.
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(
      executionsBeforeResume,
    );
    const t1Steps = (await runtime.stepRuns.list(project.runId)).filter(
      (step) => step.stepId === 'implement.T1',
    );
    expect(t1Steps.map((step) => [step.iteration, step.status])).toEqual([
      [1, 'completed'],
      [2, 'completed'],
    ]);
    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T1: T1 work',
      'agent(developer): T2: T2 work',
    ]);
  }, 60_000);
});

describe('per-task deterministic verification', () => {
  it('repairs once on a real failure and completes the task only when green', async () => {
    const executor = new TaskGraphExecutor({
      tasks: [task('T1'), task('T2', ['T1'])],
      corrupt: (request) => request.stepId === 'implement.T1',
    });
    const runtime = await createTaskLoopRuntime('task-verify', executor, GATED_TASK_LOOP_WORKFLOW);
    const project = await startProject(runtime, 'Task verification');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');

    // The whole contract of the gate, in order: the checks run, the red one
    // invokes repair, and the task is not complete until they come back green.
    expect(taskTimeline(detail.events, 'T1')).toEqual([
      'task.started',
      'quality.repair_requested',
      'quality.approved',
      'task.completed',
    ]);
    // T2's implementation was never broken, so nothing repaired it.
    expect(taskTimeline(detail.events, 'T2')).toEqual([
      'task.started',
      'quality.approved',
      'task.completed',
    ]);
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T1')).toHaveLength(1);
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T2')).toHaveLength(0);
    // Repair is what cleared the failure, not a second run of the
    // implementation: T1 was implemented exactly once.
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(1);

    // Repair is handed the failing command and its output, not a summary.
    const repairStep = (await runtime.stepRuns.list(project.runId)).find(
      (step) => step.stepId === 'repair-task.T1',
    );
    const [repairAttempt] = await runtime.stepAttempts.list(project.runId, repairStep!.id);
    const reportRef = repairAttempt?.inputArtifacts.find(
      (artifact) => artifact.name === 'verification.report',
    );
    expect(reportRef).toBeDefined();
    const report = await runtime.artifacts.getRevision(
      project.id,
      'verification.report',
      reportRef!.revision,
    );
    const failed = (report?.content as { commands: VerificationCommandResult[] }).commands.find(
      (command) => command.name === 'typecheck',
    );
    expect(failed?.exitCode).not.toBe(0);
    expect(`${failed?.stdout}${failed?.stderr}`).toContain('SyntaxError');

    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T1: T1 work',
      'agent(developer): T2: T2 work',
    ]);
    // A repaired task ends on the repair's commit, and `task.completed` says so
    // rather than pointing at the implementation the repair corrected.
    const repairCommit = (await runtime.stepAttempts.list(project.runId, repairStep!.id))[0]
      ?.commit;
    expect(repairCommit).toBeDefined();
    expect(
      detail.events.find((event) => event.type === 'task.completed' && event.data.taskId === 'T1')
        ?.data.commit,
    ).toBe(repairCommit);
    expect(await allCommits(runtime, project.id)).toContain('agent(fixer): T1: repair T1 work');
  }, 120_000);

  it('escalates to the next executor after verification exhausts repair', async () => {
    let firstAttempt = true;
    const executor = new TaskGraphExecutor({
      tasks: [task('T1')],
      corrupt: (request) => {
        if (request.stepId === 'implement.T1') return firstAttempt;
        if (request.stepId === 'repair-task.T1') {
          firstAttempt = false;
          return true;
        }
        return false;
      },
    });
    const runtime = await createTaskLoopRuntime(
      'task-verify-escalation',
      executor,
      GATED_TASK_LOOP_WORKFLOW,
    );
    const project = await startProject(runtime, 'Task verification escalation');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(2);
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T1')).toHaveLength(1);

    const routes = detail.events.filter(
      (event) => event.type === 'agent.routed' && event.nodeId === 'implement.T1',
    );
    expect(routes.map((event) => event.data.selectedIndex)).toEqual([0, 1]);
    expect(routes.map((event) => event.data.provider)).toEqual(['claude', 'codex']);

    const failure = detail.events.find(
      (event) => event.type === 'task.failed' && event.data.taskId === 'T1',
    );
    expect(failure?.data).toMatchObject({
      attempt: 1,
      maxAttempts: 2,
      executor: 'claude',
      attemptedExecutors: ['claude'],
    });
    expect(
      detail.events.find((event) => event.type === 'task.completed' && event.data.taskId === 'T1')
        ?.data.executor,
    ).toBe('codex');
  }, 120_000);

  it('resumes a failed task on the next executor after pausing before retry', async () => {
    let firstAttempt = true;
    const executor = new TaskGraphExecutor({
      tasks: [task('T1')],
      corrupt: (request) => {
        if (request.stepId === 'implement.T1') return firstAttempt;
        if (request.stepId === 'repair-task.T1') {
          firstAttempt = false;
          return true;
        }
        return false;
      },
    });
    const runtime = await createTaskLoopRuntime(
      'task-verify-escalation-resume',
      executor,
      GATED_TASK_LOOP_WORKFLOW,
    );
    const project = await startProject(runtime, 'Task verification escalation resume');
    let pausedAfterFailure = false;
    const append = runtime.events.append.bind(runtime.events);
    runtime.events.append = async (event, transaction) => {
      if (!pausedAfterFailure && event.type === 'task.failed' && event.data.taskId === 'T1') {
        pausedAfterFailure = true;
        await runtime.projectService.pauseRun(project.runId);
      }
      await append(event, transaction);
    };

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    expect(pausedAfterFailure).toBe(true);
    expect((await runtime.projectService.get(project.id)).project.status).toBe('paused');

    await runtime.projectService.resumeRun(project.runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    const routes = detail.events.filter(
      (event) => event.type === 'agent.routed' && event.nodeId === 'implement.T1',
    );
    expect(routes.map((event) => event.data.selectedIndex)).toEqual([0, 1]);
    expect(routes.map((event) => event.data.provider)).toEqual(['claude', 'codex']);
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(2);
    expect(
      detail.events.filter(
        (event) => event.type === 'step.reused' && event.data.artifact === 'implementation.report',
      ),
    ).toHaveLength(0);
  }, 120_000);

  it('fails cleanly when a red gate exhausts the executor ladder', async () => {
    const executor = new TaskGraphExecutor({
      tasks: [task('T1')],
      corrupt: (request) => request.stepId.endsWith('.T1'),
    });
    const runtime = await createTaskLoopRuntime(
      'task-verify-ladder-exhausted',
      executor,
      EXHAUSTING_GATED_TASK_LOOP_WORKFLOW,
    );
    const project = await startProject(runtime, 'Task verification ladder exhausted');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('failed');
    expect(detail.project.error).toContain('exhausted its executor ladder');
    expect(detail.project.error).toContain('typecheck');

    const routes = detail.events.filter(
      (event) => event.type === 'agent.routed' && event.nodeId === 'implement.T1',
    );
    expect(routes.map((event) => event.data.selectedIndex)).toEqual([0, 1, 2]);
    expect(routes.map((event) => event.data.provider)).toEqual(['claude', 'codex', 'agy']);
    expect(detail.events.filter((event) => event.type === 'task.failed')).toHaveLength(3);
    expect(executor.executedSteps.filter((step) => step === 'implement.T1')).toHaveLength(3);
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T1')).toHaveLength(3);
  }, 120_000);

  it('fails the task when the checks stay red, keeping earlier tasks committed', async () => {
    // T2 is broken by its implementation *and* by its repair, so the bound of
    // one repair attempt is exhausted with the checks still red.
    const executor = new TaskGraphExecutor({
      tasks: [task('T1'), task('T2', ['T1']), task('T3', ['T2'])],
      corrupt: (request) => request.stepId.endsWith('.T2'),
    });
    const runtime = await createTaskLoopRuntime(
      'task-verify-exhausted',
      executor,
      GATED_TASK_LOOP_WORKFLOW,
    );
    const project = await startProject(runtime, 'Task verification exhausted');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('failed');
    expect(detail.project.error).toContain('T2');
    expect(detail.project.error).toContain('typecheck');

    expect(taskTimeline(detail.events, 'T2')).toEqual([
      'task.started',
      'quality.repair_requested',
      'task.failed',
      'quality.repair_requested',
      'task.failed',
    ]);
    // Each task attempt keeps the repair bound, then the red verdict escalates
    // the task to the next implementation vendor.
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T2')).toHaveLength(2);
    expect(
      (await runtime.stepRuns.list(project.runId))
        .filter((step) => step.stepId === 'verify-task.T2')
        .map((step) => step.iteration),
    ).toEqual([1, 2, 3, 4]);
    // T1 survives, T2 leaves nothing behind, and T3 never starts.
    expect(await taskCommits(runtime, project.id)).toEqual(['agent(developer): T1: T1 work']);
    expect(taskEvents(detail.events, 'task.completed')).toEqual(['T1']);
    expect(executor.executedSteps.filter((step) => step === 'implement.T3')).toHaveLength(0);
  }, 120_000);
});

describe('per-task browser assertion', () => {
  it('asserts each task in a browser after its deterministic checks pass', async () => {
    const executor = new TaskGraphExecutor({ tasks: [task('T1'), task('T2', ['T1'])] });
    const runtime = await createTaskLoopRuntime(
      'task-assert',
      executor,
      ASSERTED_TASK_LOOP_WORKFLOW,
    );
    const browser = stubBrowser(runtime);
    const project = await startProject(runtime, 'Task assertion');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    // One plan and one assertion per task, each under its own per-task step id.
    expect(
      executor.executedSteps.filter((step) => step.startsWith('plan-task-browser-test.')),
    ).toEqual(['plan-task-browser-test.T1', 'plan-task-browser-test.T2']);
    expect(browser.attempts).toBe(2);

    // The assertion runs after the checks are green and before the task completes.
    expect(taskTimeline(detail.events, 'T1')).toEqual([
      'task.started',
      'quality.approved',
      'quality.approved',
      'task.completed',
    ]);
    expect(
      detail.events.filter(
        (event) => event.type === 'quality.approved' && event.data.asserted === true,
      ),
    ).toHaveLength(2);
    expect(await taskCommits(runtime, project.id)).toEqual([
      'agent(developer): T1: T1 work',
      'agent(developer): T2: T2 work',
    ]);
  }, 120_000);

  it('repairs a failed assertion once and completes the task only when it passes', async () => {
    const executor = new TaskGraphExecutor({ tasks: [task('T1')] });
    const runtime = await createTaskLoopRuntime(
      'task-assert-repair',
      executor,
      ASSERTED_TASK_LOOP_WORKFLOW,
    );
    // T1's first assertion fails; the rerun after repair passes.
    const browser = stubBrowser(runtime, [false, true]);
    const project = await startProject(runtime, 'Task assertion repair');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(browser.attempts).toBe(2);
    // Repair for a failed assertion is its own step, so the timeline says which
    // of the two loops fired.
    expect(executor.executedSteps.filter((step) => step === 'repair-task-browser.T1')).toHaveLength(
      1,
    );
    expect(executor.executedSteps.filter((step) => step === 'repair-task.T1')).toHaveLength(0);

    const requested = detail.events.find(
      (event) => event.type === 'quality.repair_requested' && event.data.taskId === 'T1',
    );
    expect(requested?.data.stepId).toBe('repair-task-browser.T1');
    // The failing step reaches repair, not just a summary.
    expect(requested?.data.failedStepId).toBe('open-root');

    // Repair is handed the plan and the report that failed against it.
    const repairStep = (await runtime.stepRuns.list(project.runId)).find(
      (step) => step.stepId === 'repair-task-browser.T1',
    );
    const [attempt] = await runtime.stepAttempts.list(project.runId, repairStep!.id);
    expect(attempt?.inputArtifacts.map((artifact) => artifact.name)).toEqual(
      expect.arrayContaining(['browser-test.plan', 'browser-verification.report']),
    );
  }, 120_000);

  it('lets a task with no user-visible surface complete without asserting', async () => {
    const executor = new TaskGraphExecutor({
      tasks: [task('T1')],
      noBrowserSurface: (request) => request.stepId === 'plan-task-browser-test.T1',
    });
    const runtime = await createTaskLoopRuntime(
      'task-assert-skip',
      executor,
      ASSERTED_TASK_LOOP_WORKFLOW,
    );
    const browser = stubBrowser(runtime);
    const project = await startProject(runtime, 'Task assertion skipped');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    // No browser ran, and the task still completed and committed.
    expect(browser.attempts).toBe(0);
    expect(
      detail.events.find(
        (event) => event.type === 'quality.approved' && event.data.asserted === false,
      )?.message,
    ).toContain('no browser assertion');
    expect(await taskCommits(runtime, project.id)).toEqual(['agent(developer): T1: T1 work']);
  }, 120_000);

  it('fails the task when the plan step returns neither a plan nor a refusal', async () => {
    const executor = new TaskGraphExecutor({
      tasks: [task('T1')],
      malformedPlan: (request) => request.stepId === 'plan-task-browser-test.T1',
    });
    const runtime = await createTaskLoopRuntime(
      'task-assert-garbage',
      executor,
      ASSERTED_TASK_LOOP_WORKFLOW,
    );
    const browser = stubBrowser(runtime, [false]);
    const project = await startProject(runtime, 'Task assertion garbage plan');

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.runId);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('failed');
    expect(detail.project.error).toContain('neither a valid browser test plan');
    // Repairing the code cannot fix a malformed plan, and the plan is pinned
    // unchanged for every rerun — so the repair budget is never spent on it.
    expect(browser.attempts).toBe(0);
    expect(executor.executedSteps.filter((step) => step === 'repair-task-browser.T1')).toHaveLength(
      0,
    );
  }, 120_000);
});
