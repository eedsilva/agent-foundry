import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentArtifact,
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import { BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA } from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { RunCancelledError } from '@agent-foundry/domain';

export class MockAgentExecutor implements AgentExecutor {
  readonly provider = 'mock';

  async execute(
    request: AgentExecutionRequest,
    signal?: AbortSignal,
    onEvent?: (event: ExecutorStreamEvent) => void,
  ): Promise<AgentExecutionResult> {
    if (signal?.aborted) throw new RunCancelledError(request.runId);
    const startedAt = Date.now();
    if (onEvent) await this.emitMockStream(request, onEvent);
    if (request.mutatesWorkspace) await this.mutateWorkspace(request);
    const output = await this.artifactFor(request);
    const stdout = JSON.stringify(output);

    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'mock',
      model: `mock:${request.provider}/${request.model || 'default'}`,
      executedModel: `mock:${request.provider}/${request.model || 'default'}`,
      exitCode: 0,
      durationMs: Date.now() - startedAt,
      stdout,
      stderr: '',
      output,
      usage: { inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0 },
    };
  }

  /**
   * Local dev/demo mode has no real CLI stdout to tap, so it has nothing to
   * show the chat UI's live-activity rendering without this. Small delays
   * make it visibly "stream" rather than arrive as one instantaneous burst;
   * only runs when a caller actually wants events (onEvent provided).
   */
  private async emitMockStream(
    request: AgentExecutionRequest,
    onEvent: (event: ExecutorStreamEvent) => void,
  ): Promise<void> {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    onEvent({ type: 'status', phase: 'started' });
    await wait(200);
    onEvent({ type: 'assistant_delta', text: `Working on ${request.stepId}...` });
    await wait(200);
    onEvent({ type: 'tool_start', toolName: 'MockTool', summary: `Reviewing ${request.taskKind}` });
    await wait(200);
    onEvent({
      type: 'tool_end',
      toolName: 'MockTool',
      summary: `Reviewed ${request.taskKind}`,
      ok: true,
    });
    await wait(200);
    onEvent({ type: 'assistant_delta', text: 'Done.' });
  }

  async health(): Promise<ExecutorHealth> {
    return {
      provider: 'mock',
      available: true,
      version: '1',
      message: 'Deterministic mock executor is enabled',
    };
  }

  private async mutateWorkspace(request: AgentExecutionRequest): Promise<void> {
    await mkdir(join(request.cwd, 'src'), { recursive: true });
    const packagePath = join(request.cwd, 'package.json');
    let packageJson: Record<string, unknown> = {};
    try {
      packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
    } catch {
      packageJson = {};
    }

    packageJson.name = packageJson.name ?? 'generated-mock-app';
    packageJson.private = true;
    packageJson.type = 'module';
    packageJson.packageManager = packageJson.packageManager ?? 'npm@10';
    packageJson.scripts = {
      typecheck: 'node --check src/index.js',
      lint: 'node --check src/index.js',
      test: 'node --test',
      build: 'node --check src/index.js',
      ...((packageJson.scripts as Record<string, string> | undefined) ?? {}),
    };
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    await writeFile(
      join(request.cwd, 'src', 'index.js'),
      [
        'export function createProject(input) {',
        "  if (!input?.name || !input?.prd) throw new Error('name and prd are required');",
        "  return { ...input, status: 'queued' };",
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(request.cwd, 'src', 'index.test.js'),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { createProject } from './index.js';",
        '',
        "test('queues a valid project', () => {",
        "  assert.equal(createProject({ name: 'x', prd: 'y' }).status, 'queued');",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
  }

  private async artifactFor(request: AgentExecutionRequest): Promise<AgentArtifact> {
    const isReview = request.taskKind.includes('review') || request.role === 'tester';
    const data =
      request.outputSchema?.$id === BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA.$id
        ? {
            schemaVersion: '1' as const,
            id: 'mock-critical-journey',
            title: 'Mock critical journey',
            viewport: { width: 1280, height: 720 },
            steps: [
              {
                id: 'open-root',
                title: 'Open the app',
                action: { kind: 'goto' as const, path: '/' },
                assertions: [],
              },
            ],
          }
        : {
            stepId: request.stepId,
            role: request.role,
            taskKind: request.taskKind,
            note: 'Generated by deterministic mock mode',
          };
    return {
      schemaVersion: '1',
      status: 'completed',
      summary: `Mock ${request.role} completed ${request.stepId}`,
      ...(isReview ? { approved: true } : {}),
      data,
      decisions: [
        {
          title: `Decision from ${request.stepId}`,
          choice: 'Use the modular workflow contract',
          rationale: 'It keeps orchestration independent from provider CLIs.',
          alternatives: ['Directly call a provider from the API route'],
          consequences: ['Provider adapters remain replaceable'],
        },
      ],
      assumptions: [],
      risks: [],
      nextActions: [],
    };
  }
}
