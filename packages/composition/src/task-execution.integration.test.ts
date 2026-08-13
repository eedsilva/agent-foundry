import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  PlanTask,
  ProjectEvent,
} from '@agent-foundry/contracts';
import { TASK_GRAPH_ARTIFACT_JSON_SCHEMA } from '@agent-foundry/contracts';
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

function task(
  id: string,
  dependsOn: string[] = [],
  acceptanceMode?: PlanTask['acceptanceMode'],
): PlanTask {
  return {
    id,
    title: `${id} work`,
    dependsOn,
    deliverables: [`src/${id}.ts`],
    acceptanceCheck: `${id} behaves`,
    module: 'crud:work',
    ...(acceptanceMode ? { acceptanceMode } : {}),
  };
}

interface TaskGraphExecutorOptions {
  tasks: PlanTask[];
  onStep?: (request: AgentExecutionRequest) => Promise<void>;
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
    const result = await this.delegate.execute(request, signal);
    await this.options.onStep?.(request);
    if (request.stepId !== 'plan') return result;
    const output = {
      ...result.output,
      data: {
        schemaVersion: '1' as const,
        goal: 'Fixture plan',
        ...(request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
          ? { modules: [{ id: 'crud:work', acceptanceChannel: 'deterministic-only' as const }] }
          : {}),
        tasks:
          request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
            ? this.options.tasks.map((task) => ({
                ...task,
                acceptanceMode: task.acceptanceMode ?? 'deterministic-only',
                module: task.module ?? 'crud:work',
              }))
            : this.options.tasks,
      },
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
function taskEvents(events: ProjectEvent[], type: ProjectEvent['type']): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.data.taskId);
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

  it('resumes a paused graph at the first incomplete task', async () => {
    // The operator pauses while T1 is in flight; the run parks at the next step
    // boundary, which is T2.
    let pause: () => Promise<void> = async () => {};
    const executor = new TaskGraphExecutor({
      tasks: [
        task('T1', [], 'deterministic-only'),
        task('T2', ['T1'], 'deterministic-only'),
        task('T3', ['T2'], 'deterministic-only'),
      ],
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
});
