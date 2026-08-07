import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  type AgentExecutionRequest,
} from '@agent-foundry/contracts';
import { ClaudeCliExecutor } from './claude-executor.js';
import { CodexCliExecutor } from './codex-executor.js';

const FAKE_CLI_DIR = resolve(import.meta.dirname, 'fixtures', 'fake-cli');

/**
 * Round-trips the real CLI executors against the checked-in fake provider
 * CLIs (#416): prompt → spawn → REQUEST.md resolution → workspace mutation →
 * stream protocol → artifact extraction. This is the seam the pipeline
 * regression e2e relies on for the LLM boundary.
 */
describe('fake provider CLIs', () => {
  let workspace: string;
  const originalPath = process.env.PATH;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'agent-foundry-fake-cli-'));
    process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  async function seedRequestFiles(
    runId: string,
    stepRunId: string,
    attemptId: string,
    identity: { stepId: string; taskKind: string; role: string },
    outputSchema: object,
  ): Promise<void> {
    const attemptDir = join(
      workspace,
      '.orchestrator',
      'runs',
      runId,
      'steps',
      stepRunId,
      'attempts',
      attemptId,
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      join(attemptDir, 'REQUEST.md'),
      [
        '# Agent execution request',
        '',
        '## Identity',
        '',
        `- Run: ${runId}`,
        `- Step run: ${stepRunId}`,
        `- Attempt: ${attemptId}`,
        `- Step: ${identity.stepId}`,
        `- Role: ${identity.role}`,
        `- Task kind: ${identity.taskKind}`,
        `- Workspace mutation allowed: ${identity.taskKind === 'implementation' || identity.taskKind === 'repair' ? 'yes' : 'no'}`,
        '',
        '## Mission',
        '',
        'Fixture mission.',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(attemptDir, 'output.schema.json'), JSON.stringify(outputSchema), 'utf8');
  }

  function request(overrides: Partial<AgentExecutionRequest>): AgentExecutionRequest {
    const runId = overrides.runId ?? 'run-1';
    const stepRunId = overrides.stepRunId ?? 'step-run-1';
    const attemptId = overrides.attemptId ?? 'attempt-1';
    return {
      runId,
      stepRunId,
      attemptId,
      projectId: 'project-1',
      stepId: 'implement',
      role: 'developer',
      taskKind: 'implementation',
      provider: 'codex',
      model: 'fake-model',
      prompt: `Open and follow .orchestrator/runs/${runId}/steps/${stepRunId}/attempts/${attemptId}/REQUEST.md exactly. Perform the task in the current workspace. Return only the required JSON object, with no Markdown fence or surrounding prose.`,
      cwd: workspace,
      mutatesWorkspace: true,
      timeoutMs: 30_000,
      ...overrides,
    };
  }

  it('reports a healthy version for both fake CLIs', async () => {
    const codex = new CodexCliExecutor(1_000_000);
    const claude = new ClaudeCliExecutor(1_000_000);
    await expect(codex.health()).resolves.toMatchObject({ available: true, provider: 'codex' });
    await expect(claude.health()).resolves.toMatchObject({ available: true, provider: 'claude' });
  });

  it('round-trips a planning step through the fake codex CLI into a task-graph artifact', async () => {
    await seedRequestFiles(
      'run-1',
      'step-plan',
      'attempt-plan',
      { stepId: 'plan', taskKind: 'planning', role: 'planner' },
      TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
    );
    const executor = new CodexCliExecutor(1_000_000);

    const result = await executor.execute(
      request({
        stepRunId: 'step-plan',
        attemptId: 'attempt-plan',
        stepId: 'plan',
        role: 'planner',
        taskKind: 'planning',
        mutatesWorkspace: false,
        outputSchema: TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: '1',
      status: 'completed',
      // The 'Fake' marker proves the fake CLI answered — never a real
      // provider CLI that happened to be on PATH.
      summary: expect.stringContaining('Fake'),
      data: { schemaVersion: '1', tasks: expect.any(Array) },
    });
    expect(result.usage?.inputTokens).toBeGreaterThan(0);
  });

  it('round-trips an implementation step through the fake claude CLI and mutates the workspace', async () => {
    await seedRequestFiles(
      'run-1',
      'step-impl',
      'attempt-impl',
      { stepId: 'implement.T1', taskKind: 'implementation', role: 'developer' },
      { $id: 'agent-artifact' },
    );
    const executor = new ClaudeCliExecutor(1_000_000);

    const result = await executor.execute(
      request({
        stepRunId: 'step-impl',
        attemptId: 'attempt-impl',
        stepId: 'implement.T1',
        provider: 'claude',
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({
      schemaVersion: '1',
      status: 'completed',
      summary: expect.stringContaining('Fake'),
    });
    const packageJson = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
    expect(packageJson.scripts.test).toBe('node --test');
    const indexSource = await readFile(join(workspace, 'src', 'index.js'), 'utf8');
    expect(indexSource).toContain('lastStep = "implement.T1"');
  });

  it('does not write workspace files on a read-only step', async () => {
    const readOnlyWorkspace = await mkdtemp(join(tmpdir(), 'agent-foundry-fake-cli-ro-'));
    await chmod(readOnlyWorkspace, 0o755);
    const attemptDir = join(
      readOnlyWorkspace,
      '.orchestrator/runs/run-1/steps/step-review/attempts/attempt-review',
    );
    await mkdir(attemptDir, { recursive: true });
    await writeFile(
      join(attemptDir, 'REQUEST.md'),
      [
        '## Identity',
        '- Run: run-1',
        '- Step run: step-review',
        '- Attempt: attempt-review',
        '- Step: review',
        '- Role: code-reviewer',
        '- Task kind: code-review',
        '- Workspace mutation allowed: no',
      ].join('\n'),
      'utf8',
    );
    const executor = new CodexCliExecutor(1_000_000);

    const result = await executor.execute(
      request({
        stepRunId: 'step-review',
        attemptId: 'attempt-review',
        stepId: 'review',
        role: 'code-reviewer',
        taskKind: 'code-review',
        mutatesWorkspace: false,
        cwd: readOnlyWorkspace,
        prompt: `Open and follow .orchestrator/runs/run-1/steps/step-review/attempts/attempt-review/REQUEST.md exactly.`,
      }),
    );

    expect(result.output).toMatchObject({ status: 'completed', approved: true });
    await expect(readFile(join(readOnlyWorkspace, 'package.json'), 'utf8')).rejects.toThrow();
  });
});
