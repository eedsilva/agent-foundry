import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentArtifact,
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  ExecutorStreamEvent,
} from '@agent-foundry/contracts';
import {
  BROWSER_TEST_PLAN_ARTIFACT_JSON_SCHEMA,
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
} from '@agent-foundry/contracts';
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
    const mockModel = `mock:${request.provider}/${request.model || 'default'}`;
    if (onEvent) await this.emitMockStream(request, onEvent);
    if (request.mutatesWorkspace) await this.mutateWorkspace(request);
    const output = await this.artifactFor(request);
    const stdout = JSON.stringify(output);

    return {
      runId: request.runId,
      stepRunId: request.stepRunId,
      attemptId: request.attemptId,
      provider: 'mock',
      model: mockModel,
      executedModel: mockModel,
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
    // The real invariant behind the preview machinery below: overwriting the
    // manager converts a pnpm workspace (the scaffold declares pnpm via the
    // corepack field) to npm with no matching lockfile, which would break the
    // preview's `npm ci`. Gate on that conversion — not on a script heuristic —
    // so dogfood/benchmark mini-workspaces and test-seeded workspaces (both
    // npm or manager-less) stay untouched; extra files would violate dogfood
    // file allowlists.
    const convertedFromPnpm =
      typeof packageJson.packageManager === 'string' &&
      packageJson.packageManager.startsWith('pnpm');
    packageJson.packageManager = 'npm@10';
    // These override whatever the scaffold ships rather than deferring to it.
    // The scaffold's real scripts (`next build`, `tsc -p`) need an install this
    // executor never performs, and the `db:*`/`smoke` scripts need Docker, the
    // Supabase CLI and both tiers running, so leaving any of them in place
    // would send every mock run into repair over a missing dependency instead
    // of exercising the workflow.
    const existingScripts = (packageJson.scripts as Record<string, string> | undefined) ?? {};
    if (convertedFromPnpm) {
      // The mock never installs anything, so declared dependencies would only
      // put package.json out of sync with the stub lockfile and fail `npm ci`.
      delete packageJson.dependencies;
      delete packageJson.devDependencies;
    }
    packageJson.scripts = {
      ...existingScripts,
      // The converted workspace's dev script drove a pnpm workspace this
      // executor never installs; a zero-dependency server keeps `npm run
      // foundry`'s preview bootable in mock mode (#443).
      ...(convertedFromPnpm ? { dev: 'node scripts/mock-dev-server.mjs' } : {}),
      typecheck: 'node --check src/index.js',
      lint: 'node --check src/index.js',
      test: 'node --test',
      build: 'node --check src/index.js',
      'server-actions:check': 'node --check src/index.js',
      'db:start': 'node -e ""',
      'db:reset': 'node -e ""',
      smoke: 'node -e ""',
      'database-row-match': `node -e "console.log('AGENT_FOUNDRY_DB_MATCH:${'0'.repeat(64)}')"`,
    };
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    if (convertedFromPnpm) {
      // A dependency-free lockfile so the preview installer's `npm ci` succeeds
      // against the mock workspace (the scaffold ships only pnpm-lock.yaml).
      const lockName = packageJson.name;
      const lockVersion = packageJson.version ?? '0.0.0';
      await writeFile(
        join(request.cwd, 'package-lock.json'),
        `${JSON.stringify(
          {
            name: lockName,
            version: lockVersion,
            lockfileVersion: 3,
            requires: true,
            packages: { '': { name: lockName, version: lockVersion } },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await mkdir(join(request.cwd, 'scripts'), { recursive: true });
      await writeFile(
        join(request.cwd, 'scripts', 'mock-dev-server.mjs'),
        [
          "import { createServer } from 'node:http';",
          'const server = createServer((request, response) => {',
          "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
          "  response.end('<html><body><h1>Generated mock app</h1><p>Served by the mock executor.</p></body></html>');",
          '});',
          "server.listen(Number(process.env.PORT ?? 0), '127.0.0.1');",
          "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
          '',
        ].join('\n'),
        'utf8',
      );
    }
    await writeFile(
      join(request.cwd, 'src', 'index.js'),
      [
        'export function createProject(input) {',
        "  if (!input?.name || !input?.prd) throw new Error('name and prd are required');",
        "  return { ...input, status: 'queued' };",
        '}',
        // Marks which step wrote this file. Without something step-specific, a
        // second mutating step leaves an identical tree, git finds nothing to
        // commit, and a per-task commit silently disappears.
        `export const lastStep = ${JSON.stringify(request.stepId)};`,
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
        : request.outputSchema?.$id === TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id
          ? {
              schemaVersion: '1' as const,
              goal: `Mock plan for ${request.stepId}`,
              tasks: [
                {
                  id: 'T1',
                  title: 'Create the project skeleton',
                  dependsOn: [],
                  deliverables: ['package.json', 'src/index.js'],
                  acceptanceCheck: 'npm test passes in the generated workspace',
                  acceptanceMode: 'deterministic-only',
                },
                {
                  id: 'T2',
                  title: 'Implement the core flow',
                  dependsOn: ['T1'],
                  deliverables: ['src/index.js'],
                  acceptanceCheck: 'createProject queues a valid project',
                  acceptanceMode: 'browser-visible',
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
