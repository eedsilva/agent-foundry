import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentExecutionRequest,
  AgentExecutionResult,
  BrowserVerificationReport,
  ExecutorHealth,
  PreviewSession,
  QueueJob,
} from '@agent-foundry/contracts';
import { SystemClock, UlidGenerator, type AgentExecutor } from '@agent-foundry/domain';
import { MockAgentExecutor, PlaywrightBrowserVerifier } from '@agent-foundry/executors';
import { BrowserVerificationCoordinator, ConversationService } from '@agent-foundry/orchestrator';
import {
  FileConversationRepository,
  FileKnowledgeFileRepository,
  FileQualityObservationRepository,
} from '@agent-foundry/persistence';
import { createRuntime, type Runtime } from './runtime.js';
import { approveDiffGate } from './testing-helpers.js';

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

class BrowserPlanExecutor implements AgentExecutor {
  readonly provider = 'mock';

  constructor(private readonly delegate: AgentExecutor = new MockAgentExecutor()) {}

  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const result = await this.delegate.execute(request);
    if (request.stepId !== 'plan-browser-test') return result;
    const output = {
      ...result.output,
      data: {
        schemaVersion: '1' as const,
        id: 'critical-crud',
        title: 'Critical CRUD journey',
        viewport: { width: 1280, height: 720 },
        steps: [
          {
            id: 'open-root',
            title: 'Open the app',
            action: { kind: 'goto' as const, path: '/' },
            assertions: [],
          },
        ],
      },
    };
    return { ...result, output, stdout: JSON.stringify(output) };
  }

  health(): Promise<ExecutorHealth> {
    return this.delegate.health();
  }
}

class FailFirstExecutor implements AgentExecutor {
  readonly provider = 'mock';
  private calls = 0;
  private readonly delegate = new BrowserPlanExecutor();

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

function configureMockBrowserRuntime(runtime: Runtime): void {
  Object.defineProperty(runtime.executors, 'executor', {
    value: new BrowserPlanExecutor(),
    configurable: true,
  });
  let sequence = 0;
  const previewSessions = new Map<string, PreviewSession>();
  Object.defineProperty(runtime.previewService, 'start', {
    configurable: true,
    value: (input: { workspaceRef: PreviewSession['workspaceRef']; runId?: string }) => {
      sequence += 1;
      const now = '2026-07-17T12:00:00.000Z';
      const session: PreviewSession = {
        id: `preview-${sequence}`,
        ...(input.runId ? { runId: input.runId } : {}),
        workspaceRef: input.workspaceRef,
        status: 'running',
        version: 3,
        url: `http://127.0.0.1:4000/preview/preview-${sequence}/?token=secret`,
        process: { command: 'npm', args: ['run', 'dev'], port: 3000 + sequence },
        health: { state: 'healthy', checkedAt: now, consecutiveFailures: 0 },
        ttl: { seconds: 1800, expiresAt: '2026-07-17T12:30:00.000Z' },
        restartCount: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };
      previewSessions.set(session.id, session);
      return Promise.resolve({ session, url: session.url! });
    },
  });
  Object.defineProperty(runtime.previewService, 'stop', {
    configurable: true,
    value: (sessionId: string) => {
      const session = previewSessions.get(sessionId);
      if (!session) return Promise.reject(new Error(`Unknown preview ${sessionId}`));
      return Promise.resolve({
        ...session,
        status: 'stopped' as const,
        updatedAt: '2026-07-17T12:00:01.000Z',
        completedAt: '2026-07-17T12:00:01.000Z',
      });
    },
  });
  Object.defineProperty(runtime.browserVerifier, 'verify', {
    configurable: true,
    value: (input: Parameters<typeof runtime.browserVerifier.verify>[0]) =>
      Promise.resolve({
        schemaVersion: '1',
        approved: true,
        summary: 'Mock browser verification passed.',
        planArtifact: input.planArtifact,
        previewSession: {
          ...input.session,
          url: input.session.url?.replace(/\?.*$/, ''),
        },
        steps: [],
      } satisfies BrowserVerificationReport),
  });
}

describe('mock runtime', () => {
  it('composes the Playwright browser verifier through the preview coordinator', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-browser-runtime-'));
    temporaryDirectories.push(dataDir);
    const rootDir = resolve(import.meta.dirname, '../../..');
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });

    expect(runtime.browserVerifier).toBeInstanceOf(PlaywrightBrowserVerifier);
    expect(runtime.browserVerification).toBeInstanceOf(BrowserVerificationCoordinator);
    expect(
      (runtime as Runtime & { qualityObservations?: unknown }).qualityObservations,
    ).toBeInstanceOf(FileQualityObservationRepository);
    expect((runtime as Runtime & { knowledgeFiles?: unknown }).knowledgeFiles).toBeInstanceOf(
      FileKnowledgeFileRepository,
    );
  });

  it('binds mock browser screenshot evidence to the same direct-edit run', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-visual-edit-browser-'));
    temporaryDirectories.push(dataDir);
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const plan = await runtime.artifacts.put({
      projectId: 'project-visual',
      name: 'visual-edit-browser-plan-operation-1',
      runId: 'run-visual',
      createdBy: 'test',
      content: {
        schemaVersion: '1',
        status: 'completed',
        summary: 'Bounded style smoke',
        data: {
          schemaVersion: '1',
          id: 'visual-edit-operation-1',
          title: 'Verify visual edit',
          viewport: { width: 1280, height: 800 },
          steps: [
            {
              id: 'verify-visual-edit',
              title: 'Verify visual edit',
              action: { kind: 'goto', path: '/' },
              assertions: [],
            },
          ],
        },
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
    });

    const report = await runtime.browserVerification.verify(
      {
        projectId: 'project-visual',
        workspacePath: runtime.workspaces.workspacePath('project-visual'),
        runId: 'run-visual',
        plan,
        allowedOrigins: [],
        evidencePolicy: { captureTrace: false, captureVideo: false },
      },
      new AbortController().signal,
    );

    expect(report.previewSession.evidence.screenshots).toHaveLength(1);
    const [screenshot] = report.previewSession.evidence.screenshots;
    expect(
      (await runtime.artifacts.listMetadata('project-visual', screenshot!.name))[0]?.runId,
    ).toBe('run-visual');
  });

  it('rejects project export when a canonical conversation is stored under another project', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-cross-paired-conversation-'));
    temporaryDirectories.push(dataDir);
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Cross-paired conversation',
      workflowId: 'web-app-v1',
      prd: 'Build a persistent project whose exported conversation identity stays canonical.',
    });
    const root = join(dataDir, 'projects', project.id, 'conversation');
    await mkdir(root);
    await writeFile(
      join(root, 'conversation.json'),
      `${JSON.stringify({
        id: 'project-2',
        projectId: 'project-2',
        createdAt: project.createdAt,
      })}\n`,
    );

    await expect(runtime.conversationService.export(project.id)).rejects.toThrow();
  });

  it('rejects project export when the conversation storage path is corrupt', async () => {
    const projectDataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-export-project-'));
    const conversationDataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-export-corrupt-'));
    temporaryDirectories.push(projectDataDir, conversationDataDir);
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: projectDataDir,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    });
    const project = await runtime.projectService.create({
      name: 'Corrupt conversation storage',
      workflowId: 'web-app-v1',
      prd: 'Build a persistent project whose export fails closed on corrupt conversation storage.',
    });
    await writeFile(join(conversationDataDir, 'projects'), 'corrupt path shape');
    const service = new ConversationService(
      runtime.projects,
      runtime.runs,
      runtime.artifacts,
      new FileConversationRepository(conversationDataDir),
      new SystemClock(),
      new UlidGenerator(),
    );

    await expect(service.export(project.id)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

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

  it('runs the complete workflow in default mock mode without runtime patches', async () => {
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

    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const runId = project.currentRunId;

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveDiffGate(runtime, runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(detail.project.currentRunId).toBe(project.currentRunId);
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
    // Approval gates (e.g. diff-approval) get a StepRun but never a StepAttempt.
    const executableStepRuns = stepRuns.filter((step) => step.stepType !== 'approval-gate');
    expect(attempts.length).toBeGreaterThanOrEqual(executableStepRuns.length);
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
      'browser-test.plan',
      'browser-verification.report',
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
        implementationRoute.profile.category,
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
    configureMockBrowserRuntime(runtime);
    Object.defineProperty(runtime.executors, 'executor', { value: new FailFirstExecutor() });

    const project = await runtime.projectService.create({
      name: 'Fallback sample',
      workflowId: 'web-app-v1',
      prd: 'Build a small, persistent issue tracker with validation, filters, tests, type checking, clear failure states, and a production build.',
    });

    if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
    const runId = project.currentRunId;

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveDiffGate(runtime, runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
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
      route.profile.category,
    );
    const originallySelectedMetric = await runtime.metrics.get(
      route.selected.model.id,
      route.profile.taskKind,
      route.profile.role,
      route.profile.category,
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
    configureMockBrowserRuntime(runtime);
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
    const afterFirstRun = await runtime.projects.get('legacy-project');
    if (!afterFirstRun?.currentRunId) throw new Error('Expected a persisted workflow run');
    const runId = afterFirstRun.currentRunId;
    await approveDiffGate(runtime, runId);
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
