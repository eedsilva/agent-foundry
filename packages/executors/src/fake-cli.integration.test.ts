import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  UI_QUALITY_JUDGE_JSON_SCHEMA,
  GeneratedTaskGraphArtifactSchema,
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
    // PATH mutation is process-wide; this file lives in the serial slow
    // bucket (--maxWorkers=1) so no concurrent test observes it.
    process.env.PATH = `${FAKE_CLI_DIR}:${originalPath}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
  });

  // Hand-written copy of compileRequestMarkdown's Identity block
  // (packages/orchestrator/src/prompt-compiler.ts) — executors cannot depend
  // on the orchestrator package. The fake CLI throws on missing fields, so a
  // format change over there fails this test loudly rather than silently.
  async function seedRequestFiles(
    workspaceDir: string,
    runId: string,
    stepRunId: string,
    attemptId: string,
    identity: { stepId: string; taskKind: string; role: string; mutationAllowed: boolean },
    outputSchema: object,
  ): Promise<void> {
    const attemptDir = join(
      workspaceDir,
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
        `- Workspace mutation allowed: ${identity.mutationAllowed ? 'yes' : 'no'}`,
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
      workspace,
      'run-1',
      'step-plan',
      'attempt-plan',
      { stepId: 'plan', taskKind: 'planning', role: 'planner', mutationAllowed: false },
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
    // The fake CLI's task-graph fixture must satisfy the same schema the
    // real planner's output is validated against (#479) — every task
    // carries its module, and the graph carries the module list.
    const parsed = GeneratedTaskGraphArtifactSchema.parse(result.output);
    expect(parsed.data.modules.length).toBeGreaterThan(0);
    expect(parsed.data.tasks.every((task) => typeof task.module === 'string')).toBe(true);
  });

  it('round-trips an implementation step through the fake claude CLI and mutates the workspace', async () => {
    await seedRequestFiles(
      workspace,
      'run-1',
      'step-impl',
      'attempt-impl',
      {
        stepId: 'implement.T1',
        taskKind: 'implementation',
        role: 'developer',
        mutationAllowed: true,
      },
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
    await seedRequestFiles(
      readOnlyWorkspace,
      'run-1',
      'step-review',
      'attempt-review',
      { stepId: 'review', taskKind: 'code-review', role: 'code-reviewer', mutationAllowed: false },
      { $id: 'agent-artifact' },
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

  // #548: the UI-quality judge (packages/orchestrator/src/ui-quality-judge.ts)
  // calls executor.execute() directly with a raw prompt that never references
  // a REQUEST.md — there is no per-step run context on disk for it, unlike
  // every other caller above. Codex still receives the schema: its invocation
  // (output-schema-prompt.ts) always appends "Output JSON Schema:" plus the
  // schema JSON to the stdin prompt, which is the only channel the fake CLI
  // has to recognize this request without a REQUEST.md to read.
  it('answers the UI-quality judge prompt with a schema-conforming payload through the fake codex CLI', async () => {
    const executor = new CodexCliExecutor(1_000_000);

    const result = await executor.execute(
      request({
        stepId: 'browser-verify.T2',
        role: 'tester',
        taskKind: 'verification',
        mutatesWorkspace: false,
        provider: 'codex',
        prompt: [
          'You are judging the visual quality of a web application that was just exercised by an automated browser test.',
          '',
          'Review these screenshot files, relative to your working directory:',
          '- 0-load-root.png (browser step "load-root")',
          '',
          'Score the UI against every criterion of rubric version 1:',
          '- layout-coherence (Layout coherence): Elements are visually organized.',
          '',
          'Rules:',
          '- Emit exactly one entry in "criteria" per rubric criterion, using the criterion id verbatim.',
          '- "score" and "overallScore" are numbers from 0 (unusable) to 1 (excellent).',
        ].join('\n'),
        outputSchema: UI_QUALITY_JUDGE_JSON_SCHEMA,
      }),
    );

    expect(result.exitCode).toBe(0);
    const data = (result.output as { data: unknown }).data as {
      overallScore: number;
      criteria: Array<{ criterionId: string; score: number }>;
    };
    expect(typeof data.overallScore).toBe('number');
    expect(data.overallScore).toBeGreaterThanOrEqual(0);
    expect(data.overallScore).toBeLessThanOrEqual(1);
    expect(data.criteria.length).toBeGreaterThan(0);
    for (const criterion of data.criteria) {
      expect(typeof criterion.criterionId).toBe('string');
      expect(typeof criterion.score).toBe('number');
    }
  });
});
