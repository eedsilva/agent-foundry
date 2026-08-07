import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentExecutionRequest, ExecutorStreamEvent } from '@agent-foundry/contracts';
import { TASK_GRAPH_ARTIFACT_JSON_SCHEMA, TaskGraphArtifactSchema } from '@agent-foundry/contracts';
import { MockAgentExecutor } from './mock-executor.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'mock-executor-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const request: AgentExecutionRequest = {
  runId: 'run-1',
  stepRunId: 'step-run-1',
  attemptId: 'attempt-1',
  projectId: 'project-1',
  stepId: 'implement',
  role: 'developer',
  taskKind: 'implementation',
  provider: 'codex',
  model: 'selected-alias',
  prompt: 'Implement the thing.',
  cwd: '/tmp/scrubbed-workspace',
  mutatesWorkspace: false,
  timeoutMs: 10_000,
};

describe('MockAgentExecutor stream events', () => {
  it('never calls onEvent when it is not provided', async () => {
    const executor = new MockAgentExecutor();
    const result = await executor.execute({ ...request, cwd, mutatesWorkspace: true });
    expect(result.provider).toBe('mock');
    await expect(readFile(join(cwd, 'package.json'), 'utf8')).resolves.toContain(
      '"packageManager": "npm@10"',
    );
  });

  it('overrides the scaffold verification scripts it finds in the workspace', async () => {
    // The scaffold ships real scripts that need an installed workspace; a mock
    // run never installs one, so deferring to them would send every mock run
    // into repair over missing dependencies.
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.30.1',
        scripts: { build: 'pnpm --recursive build', dev: 'pnpm --recursive --parallel dev' },
      }),
    );

    await new MockAgentExecutor().execute({ ...request, cwd, mutatesWorkspace: true });

    const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    expect(packageJson.packageManager).toBe('npm@10');
    expect(packageJson.scripts.build).toBe('node --check src/index.js');
    // The scaffold's pnpm dev script is replaced by the zero-dependency mock
    // server so the preview boots in mock mode (#443); npm ci gets a lockfile.
    expect(packageJson.scripts.dev).toBe('node scripts/mock-dev-server.mjs');
    const lock = JSON.parse(await readFile(join(cwd, 'package-lock.json'), 'utf8'));
    expect(lock.lockfileVersion).toBe(3);
    await expect(readFile(join(cwd, 'scripts', 'mock-dev-server.mjs'), 'utf8')).resolves.toContain(
      'createServer',
    );
  });

  it('keeps a test-seeded dev script and adds no preview files to non-pnpm workspaces', async () => {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ packageManager: 'npm@10', scripts: { dev: 'node server.mjs' } }),
    );

    await new MockAgentExecutor().execute({ ...request, cwd, mutatesWorkspace: true });

    const packageJson = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
    expect(packageJson.scripts.dev).toBe('node server.mjs');
    // Non-scaffold workspaces get no preview machinery: extra files would
    // violate dogfood/benchmark file allowlists.
    await expect(readFile(join(cwd, 'package-lock.json'), 'utf8')).rejects.toThrow();
  });

  it('emits a deterministic status/delta/tool sequence when onEvent is provided', async () => {
    const executor = new MockAgentExecutor();
    const events: ExecutorStreamEvent[] = [];

    await executor.execute({ ...request, cwd }, undefined, (event) => events.push(event));

    expect(events.map((event) => event.type)).toEqual([
      'status',
      'assistant_delta',
      'tool_start',
      'tool_end',
      'assistant_delta',
    ]);
    const toolStart = events[2];
    const toolEnd = events[3];
    if (toolStart?.type === 'tool_start' && toolEnd?.type === 'tool_end') {
      expect(toolStart.toolName).toBe(toolEnd.toolName);
      expect(toolEnd.ok).toBe(true);
    } else {
      throw new Error('expected tool_start/tool_end events at indices 2 and 3');
    }
  });
});

describe('MockAgentExecutor output contracts', () => {
  it('emits a valid task graph when the task-graph schema is requested', async () => {
    const result = await new MockAgentExecutor().execute({
      ...request,
      stepId: 'plan',
      role: 'planner',
      taskKind: 'planning',
      outputSchema: TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
    });

    const graph = TaskGraphArtifactSchema.parse(result.output);
    expect(graph.data.tasks.length).toBeGreaterThan(0);
    expect(graph.data.tasks.every((task) => task.deliverables.length > 0)).toBe(true);
  });

  it('keeps the prose data shape when no contract schema is requested', async () => {
    const result = await new MockAgentExecutor().execute({ ...request, stepId: 'plan' });
    expect(result.output.data).toMatchObject({ stepId: 'plan' });
    expect(TaskGraphArtifactSchema.safeParse(result.output).success).toBe(false);
  });
});
