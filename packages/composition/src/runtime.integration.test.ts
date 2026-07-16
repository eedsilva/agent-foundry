import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  ExecutorHealth,
  QueueJob,
} from '@agent-foundry/contracts';
import type { AgentExecutor } from '@agent-foundry/domain';
import { MockAgentExecutor } from '@agent-foundry/executors';
import { createRuntime } from './runtime.js';

const RESTART_APPROVAL_WORKFLOW = `
schemaVersion: '1'
id: restart-approval-v1
name: Restart approval fixture
description: Persisted feedback restart coverage.
stack: nextjs
nodes:
  - id: plan
    type: agent
    role: planner
    taskKind: planning
    title: Draft a plan
    instructions: Draft a short plan from the PRD.
    outputArtifact: plan.current

  - id: plan-approval
    type: approval-gate
    title: Plan approval
    artifact: plan.current
    outputArtifact: plan.approval
    actions: [approve, request-changes]
    returnToStepId: plan
    repairArtifact: plan.repair-notes
`;

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

class AlwaysFailExecutor implements AgentExecutor {
  readonly provider = 'mock';

  async execute(): Promise<AgentExecutionResult> {
    throw new Error('synthetic provider failure');
  }

  health(): Promise<ExecutorHealth> {
    return new MockAgentExecutor().health();
  }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('mock runtime', () => {
  it('restarts from disk with the exact redacted feedback revision in the repair attempt', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-restart-'));
    const workflowsDir = await mkdtemp(join(tmpdir(), 'agent-foundry-feedback-workflows-'));
    temporaryDirectories.push(dataDir, workflowsDir);
    await writeFile(
      join(workflowsDir, 'restart-approval-v1.yaml'),
      RESTART_APPROVAL_WORKFLOW,
      'utf8',
    );
    const rootDir = resolve(import.meta.dirname, '../../..');
    const commonEnv = {
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: workflowsDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    };
    const runtimeA = await createRuntime({ ...commonEnv, WORKER_ID: 'feedback-worker-a' });
    const project = await runtimeA.projectService.create({
      name: 'Feedback restart sample',
      workflowId: 'restart-approval-v1',
      prd: 'Build a small persistent issue tracker with validation and deterministic tests.',
    });
    if (!project.currentRunId) throw new Error('Expected a persisted workflow run');
    const runId = project.currentRunId;
    expect(await runtimeA.worker.runOnce()).toBe(true);
    const [approval] = await runtimeA.projectService.listApprovals(runId);
    const rawSecret = 'abcdef1234567890ABCDEF';
    const decided = await runtimeA.projectService.decideApproval(runId, approval!.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: `add restart coverage; Authorization: Bearer ${rawSecret}`,
    });
    const feedbackRef = decided.run.retry?.feedbackArtifact;
    expect(feedbackRef).toBeDefined();
    const feedback = await runtimeA.artifacts.getRevision(
      project.id,
      feedbackRef!.name,
      feedbackRef!.revision,
    );
    expect(feedback?.content).toMatchObject({
      note: 'add restart coverage; Authorization: [REDACTED]',
    });

    const runtimeB = await createRuntime({ ...commonEnv, WORKER_ID: 'feedback-worker-b' });
    expect(await runtimeB.worker.runOnce()).toBe(true);

    const activePlan = (await runtimeB.stepRuns.list(runId)).find(
      (step) => step.stepId === 'plan' && !step.invalidatedAt,
    );
    expect(activePlan).toBeDefined();
    const repairAttempt = (await runtimeB.stepAttempts.list(runId, activePlan!.id)).at(-1);
    expect(repairAttempt?.inputArtifacts).toContainEqual(feedbackRef);
    const requestMarkdown = await readFile(
      join(
        runtimeB.workspaces.workspacePath(project.id),
        '.orchestrator',
        'runs',
        runId,
        'steps',
        activePlan!.id,
        'attempts',
        repairAttempt!.id,
        'REQUEST.md',
      ),
      'utf8',
    );
    expect(requestMarkdown).toContain(
      `### ${feedbackRef!.name} · revision ${feedbackRef!.revision}`,
    );
    expect(requestMarkdown).toContain(`SHA-256: ${feedbackRef!.sha256}`);
    expect(requestMarkdown).toContain('add restart coverage; Authorization: [REDACTED]');
    expect(requestMarkdown).not.toContain(rawSecret);
  }, 30_000);

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
    expect(detail.project.currentRunId).toBe(project.currentRunId);
    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const workflowRun = await runtime.runs.get(project.currentRunId);
    expect(workflowRun).toMatchObject({ status: 'completed', projectId: project.id });
    const stepRuns = await runtime.stepRuns.list(project.currentRunId);
    expect(stepRuns.length).toBeGreaterThan(0);
    expect(stepRuns.every((step) => step.status === 'completed')).toBe(true);
    const attempts = (
      await Promise.all(
        stepRuns.map((step) => runtime.stepAttempts.list(project.currentRunId!, step.id)),
      )
    ).flat();
    expect(attempts.length).toBeGreaterThanOrEqual(stepRuns.length);
    expect(attempts.every((attempt) => attempt.outputArtifacts.length > 0)).toBe(true);
    const agentAttempts = attempts.filter((attempt) => attempt.executorKind === 'agent');
    expect(agentAttempts.length).toBeGreaterThan(0);
    expect(
      agentAttempts.every(
        (attempt) =>
          attempt.provider !== 'internal' &&
          attempt.model.length > 0 &&
          attempt.executedModel?.startsWith('mock:') &&
          attempt.routeDecision &&
          attempt.harness &&
          attempt.context.projectId === project.id &&
          attempt.usage?.inputTokens === 100,
      ),
    ).toBe(true);
    expect(agentAttempts.some((attempt) => attempt.checkpoint)).toBe(true);
    expect(agentAttempts.some((attempt) => attempt.inputArtifacts.length > 0)).toBe(true);
    expect(
      attempts.some(
        (attempt) =>
          attempt.executorKind === 'verification' &&
          attempt.provider === 'internal' &&
          attempt.model === 'workspace-verifier',
      ),
    ).toBe(true);
    const firstAgentAttempt = agentAttempts[0]!;
    await expect(
      readFile(
        join(
          runtime.workspaces.workspacePath(project.id),
          '.orchestrator',
          'runs',
          project.currentRunId,
          'steps',
          firstAgentAttempt.stepRunId,
          'attempts',
          firstAgentAttempt.id,
          'REQUEST.md',
        ),
        'utf8',
      ),
    ).resolves.toContain(firstAgentAttempt.id);

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

    const retried = await runtime.projectService.retry(project.id);
    expect(retried.currentRunId).not.toBe(project.currentRunId);
    expect(retried.status).toBe('queued');
    expect(
      retried.currentRunId ? await runtime.runs.get(retried.currentRunId) : null,
    ).toMatchObject({
      status: 'queued',
    });
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
    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const planStep = (await runtime.stepRuns.list(project.currentRunId)).find(
      (step) => step.stepId === 'plan',
    );
    if (!planStep) throw new Error('Expected a persisted plan step');
    const planAttempts = await runtime.stepAttempts.list(project.currentRunId, planStep.id);
    expect(planAttempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);

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

  it('closes the active attempt, step, and run when execution fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-failed-run-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'failed-run-worker',
    });
    Object.defineProperty(runtime.executors, 'executor', { value: new AlwaysFailExecutor() });
    const project = await runtime.projectService.create({
      name: 'Failed run sample',
      workflowId: 'web-app-v1',
      prd: 'Build a small persistent issue tracker with clear validation, deterministic tests, diagnostics, and production build checks.',
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const run = await runtime.runs.get(project.currentRunId);
    const steps = await runtime.stepRuns.list(project.currentRunId);
    const attempts = steps.length
      ? await runtime.stepAttempts.list(project.currentRunId, steps[0]!.id)
      : [];
    const detail = await runtime.projectService.get(project.id);

    expect(run).toMatchObject({ status: 'failed' });
    expect(steps[0]).toMatchObject({ status: 'failed' });
    expect(attempts.at(-1)).toMatchObject({ status: 'failed' });
    expect(detail.project).toMatchObject({
      status: 'failed',
      currentRunId: project.currentRunId,
      currentNodeId: steps[0]?.nodeId,
      error: 'synthetic provider failure',
    });
    expect(attempts.at(-1)?.outputArtifacts).toHaveLength(1);
  }, 30_000);

  it('lazily creates a workflow run for a queued v0.1 job', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-legacy-job-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'legacy-job-worker',
    });
    const createdAt = '2026-07-14T12:00:00.000Z';
    await runtime.workspaces.ensure('legacy-project');
    await runtime.workspaces.writePrd(
      'legacy-project',
      'Build a small persistent issue tracker with deterministic tests and production build checks.',
    );
    await runtime.projects.create({
      id: 'legacy-project',
      name: 'Legacy project',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'queued',
      version: 1,
      createdAt,
      updatedAt: createdAt,
    });
    await runtime.artifacts.put({
      projectId: 'legacy-project',
      name: 'prd',
      content:
        'Build a small persistent issue tracker with deterministic tests and production build checks.',
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    const legacyJob = JSON.parse(
      await readFile(
        new URL('../../persistence/src/fixtures/queue-job-v0.1.json', import.meta.url),
        'utf8',
      ),
    ) as QueueJob;
    await runtime.queue.enqueue(legacyJob);

    expect(await runtime.worker.runOnce()).toBe(true);
    const project = await runtime.projects.get('legacy-project');
    expect(project).toMatchObject({ status: 'completed' });
    expect(project?.currentRunId).toBeDefined();
    expect(
      project?.currentRunId ? await runtime.runs.get(project.currentRunId) : null,
    ).toMatchObject({
      status: 'completed',
    });
  }, 30_000);
});
