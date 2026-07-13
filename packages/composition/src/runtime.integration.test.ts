import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { MockAgentExecutor } from '@agent-foundry/executors';
import { createRuntime } from './runtime.js';

class FailFirstExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private calls = 0;
  private readonly delegate = new MockAgentExecutor();

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    this.calls += 1;
    if (this.calls === 1) throw new Error('synthetic first-candidate failure');
    return this.delegate.execute(request);
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

describe('mock runtime', () => {
  it('runs the complete workflow and persists auditable artifacts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'integration-worker',
    });

    const project = await runtime.projectService.create({
      name: 'Integration sample',
      workflowId: 'web-app-v1',
      prd: [
        '# PRD',
        'Build a tiny issue tracker with create and complete flows.',
        'Persist issues, validate inputs, expose clear failure states, and add deterministic tests.',
      ].join('\n\n'),
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');

    const names = new Set(detail.artifacts.map((artifact) => artifact.metadata.name));
    for (const name of [
      'prd',
      'plan.current',
      'plan.review',
      'architecture.current',
      'architecture.review',
      'implementation.report',
      'code.review',
      'verification.report',
      'release.review',
      'decision-log',
    ]) {
      expect(names.has(name), `missing artifact ${name}`).toBe(true);
    }

    const verification = detail.artifacts.find(
      (artifact) => artifact.metadata.name === 'verification.report',
    );
    expect(verification?.content).toMatchObject({ approved: true });
    expect(detail.events.some((event) => event.type === 'agent.routed')).toBe(true);
    expect(detail.events.at(-1)?.type).toBe('project.completed');

    const implementation = detail.artifacts.find(
      (artifact) => artifact.metadata.name === 'implementation.report',
    );
    const implementationRoute = implementation?.metadata.routeDecision;
    expect(implementationRoute).toBeDefined();
    if (implementationRoute) {
      const metric = await runtime.metrics.get(
        implementationRoute.selected.model.id,
        implementationRoute.profile.taskKind,
        implementationRoute.profile.role,
      );
      expect(metric?.qualityEvaluations).toBeGreaterThanOrEqual(1);
      expect(metric?.qualityApprovals).toBeGreaterThanOrEqual(1);
    }

    const runArtifact = detail.artifacts.find((artifact) =>
      artifact.metadata.name.startsWith('run-'),
    );
    expect(runArtifact?.content).toMatchObject({
      harness: { version: '2026.07.13-v3' },
    });

    const generatedPackage = JSON.parse(
      await readFile(join(runtime.workspaces.workspacePath(project.id), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(generatedPackage.scripts?.test).toBe('node --test');
  }, 30_000);

  it('attributes review quality to the fallback that actually executed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-fallback-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'fallback-worker',
    });
    Object.defineProperty(runtime.executors, 'executor', { value: new FailFirstExecutor() });

    const project = await runtime.projectService.create({
      name: 'Fallback sample',
      workflowId: 'web-app-v1',
      prd: 'Build a small, persistent issue tracker with validation, filters, tests, type checking, clear failure states, and a production build.',
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');

    const plan = detail.artifacts.find((artifact) => artifact.metadata.name === 'plan.current');
    const route = plan?.metadata.routeDecision;
    expect(route?.attemptedModelIds).toHaveLength(2);
    expect(route?.executed?.model.id).not.toBe(route?.selected.model.id);

    if (!route?.executed) throw new Error('Expected an executed fallback route');
    const executedMetric = await runtime.metrics.get(
      route.executed.model.id,
      route.profile.taskKind,
      route.profile.role,
    );
    const originallySelectedMetric = await runtime.metrics.get(
      route.selected.model.id,
      route.profile.taskKind,
      route.profile.role,
    );
    expect(executedMetric?.qualityApprovals).toBeGreaterThanOrEqual(1);
    expect(originallySelectedMetric?.qualityEvaluations ?? 0).toBe(0);
    expect(originallySelectedMetric?.consecutiveFailures).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
