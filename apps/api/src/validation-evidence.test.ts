import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createValidationCampaignExecution,
  type ValidationCampaignPreview,
  type ValidationPreflightReport,
  type ValidationEvidenceReference,
} from '@agent-foundry/contracts';
import {
  createRuntime,
  createValidationCampaignTestExecutorRegistry,
  type Runtime,
} from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

async function controlledValidationPreflight(
  campaign: ValidationCampaignPreview,
): Promise<ValidationPreflightReport> {
  return {
    schemaVersion: '1',
    campaignId: campaign.id,
    sourceRevision: campaign.sourceRevision,
    dataDirectory: '/tmp/validation-evidence-test',
    executorMode: 'real',
    environmentId: 'validation-preflight-test',
    startedAt: '2026-08-04T12:00:00.000Z',
    completedAt: '2026-08-04T12:00:01.000Z',
    status: 'passed',
    checks: [{ boundary: 'source-revision', status: 'passed', durationMs: 1 }],
    generatedProjectCreated: false,
  };
}

async function createEvidenceRuntime(): Promise<Runtime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'validation-evidence-data-'));
  directories.push(dataDir);
  const runtime = await createRuntime(
    {
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: resolve(import.meta.dirname, '../../../workflows'),
      EXECUTOR_MODE: 'real',
      VALIDATION_CAMPAIGN: 'real-todo-v1',
      CODEX_DEFAULT_MODEL: 'gpt-5.6-luna',
      CLAUDE_FAST_MODEL: 'claude-haiku-4-5-20251001',
      WORKER_ID: 'validation-evidence-worker',
    } as NodeJS.ProcessEnv,
    undefined,
    undefined,
    {
      generatedProjectRuntime: null,
      validationPreflight: controlledValidationPreflight,
    },
  );
  if (!runtime.runValidationPreflight) throw new Error('validation preflight is unavailable');
  await runtime.runValidationPreflight();
  return runtime;
}

async function createRun(
  runtime: Runtime,
  app: Awaited<ReturnType<typeof buildApp>>,
  index: number,
  outcome: 'accepted' | 'product-failed' | 'model-failed' | 'environment-blocked' = 'accepted',
): Promise<string> {
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: {
      name: `Evidence ${index}`,
      prd: 'Create a small TODO application with persistent storage and a visible list.',
      workflowId: 'web-app-v1',
    },
  });
  expect(projectResponse.statusCode).toBe(202);
  const project = projectResponse.json().project as Awaited<
    ReturnType<Runtime['projectService']['create']>
  >;
  const run = await runtime.runs.get(project.currentRunId!);
  if (!run || !runtime.validationCampaign) throw new Error('validation run was not created');
  const now = new Date().toISOString();
  await runtime.runs.update(
    {
      ...run,
      status: outcome === 'accepted' || outcome === 'product-failed' ? 'completed' : 'failed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      ...(outcome === 'model-failed'
        ? {
            error: {
              name: 'ProviderAuthenticationError',
              message: 'provider failed with sk-test-secret-1234567890',
              code: 'AUTH_TOKEN',
            },
          }
        : outcome === 'environment-blocked'
          ? {
              error: {
                name: 'EnvironmentOperationError',
                message: 'preview failed',
                code: 'PREVIEW_UNHEALTHY',
              },
            }
          : {}),
      execution: {
        activeElapsedMs: 1,
        consecutiveRepairs: 0,
        campaign: createValidationCampaignExecution(runtime.validationCampaign),
      },
    },
    run.version,
  );
  await runtime.artifacts.put({
    projectId: run.projectId,
    name: 'validation-preflight',
    content: {
      schemaVersion: '1',
      campaignId: runtime.validationCampaign.id,
      sourceRevision: runtime.validationCampaign.sourceRevision,
      dataDirectory: '/tmp/validation-evidence-test',
      executorMode: 'real',
      environmentId: `validation-preflight-${index}`,
      startedAt: now,
      completedAt: now,
      status: outcome === 'environment-blocked' ? 'environment-blocked' : 'passed',
      checks: [
        {
          boundary: 'source-revision',
          status: outcome === 'environment-blocked' ? 'failed' : 'passed',
          durationMs: 1,
        },
      ],
      generatedProjectCreated: false,
    },
    createdBy: 'validation-evidence-test',
    runId: run.id,
  });
  const stepRunId = `evidence-step-${index}`;
  await runtime.stepRuns.create({
    id: stepRunId,
    runId: run.id,
    nodeId: 'implement',
    stepId: 'implement.persistent-storage',
    stepType: 'agent',
    status: 'completed',
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
  });
  await runtime.stepAttempts.create({
    id: `evidence-attempt-${index}`,
    runId: run.id,
    stepRunId,
    sequence: 1,
    executorKind: 'agent',
    provider: 'codex',
    model: 'gpt-5.6-luna',
    modelId: 'codex-default',
    status: 'succeeded',
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    durationMs: 10,
    usage: { providerReportedCostUsd: 0.1 },
    checkpoint: `checkpoint-${index}`,
    context: {
      projectId: project.id,
      workflowId: project.workflowId,
      nodeId: 'implement',
      stepId: 'implement.persistent-storage',
    },
    inputArtifacts: [],
    outputArtifacts: [],
  });
  for (const [taskIndex, taskId] of [
    ['2', 'create-list-api'],
    ['3', 'visible-todo-flow'],
  ] as const) {
    const taskStepRunId = `${stepRunId}-${taskIndex}`;
    const taskAttemptId = `evidence-attempt-${index}-${taskIndex}`;
    await runtime.stepRuns.create({
      id: taskStepRunId,
      runId: run.id,
      nodeId: 'implement',
      stepId: `implement.${taskId}`,
      stepType: 'agent',
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    });
    await runtime.stepAttempts.create({
      id: taskAttemptId,
      runId: run.id,
      stepRunId: taskStepRunId,
      sequence: 1,
      executorKind: 'agent',
      provider: 'codex',
      model: 'gpt-5.6-luna',
      modelId: 'codex-default',
      status: 'succeeded',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      durationMs: 10,
      usage: { providerReportedCostUsd: 0.1 },
      checkpoint: `checkpoint-${index}-${taskId}`,
      context: {
        projectId: project.id,
        workflowId: project.workflowId,
        nodeId: 'implement',
        stepId: `implement.${taskId}`,
      },
      inputArtifacts: [],
      outputArtifacts: [],
    });
  }
  return run.id;
}

type EvidenceProofs = Partial<Record<string, ValidationEvidenceReference>>;

async function seedAcceptedProof(
  runtime: Runtime,
  runId: string,
  index: number,
): Promise<EvidenceProofs> {
  const run = await runtime.runs.get(runId);
  if (!run) throw new Error(`run ${runId} not found`);
  const now = new Date().toISOString();
  const projectArtifact = await runtime.artifacts.getLatest(run.projectId, 'prd');
  if (!projectArtifact) throw new Error('project PRD artifact was not created');
  const proofs: EvidenceProofs = {
    'project-created': {
      runId,
      artifact: {
        name: projectArtifact.metadata.name,
        revision: projectArtifact.metadata.revision,
        sha256: projectArtifact.metadata.sha256,
      },
    },
  };
  const browserPlan = await runtime.artifacts.put({
    projectId: run.projectId,
    name: 'browser-test.plan',
    content: {
      schemaVersion: '1',
      status: 'completed',
      summary: 'TODO browser plan.',
      data: {
        schemaVersion: '1',
        id: 'todo-flow',
        title: 'TODO flow',
        viewport: { width: 1280, height: 720 },
        steps: [
          {
            id: 'open-todos',
            title: 'Open TODO list',
            action: { kind: 'goto', path: '/' },
            assertions: [
              { kind: 'visible', locator: { by: 'role', role: 'heading', name: 'TODOs' } },
            ],
          },
          {
            id: 'fill-todo',
            title: 'Fill TODO title',
            action: {
              kind: 'fill',
              locator: { by: 'label', label: 'Title' },
              value: 'Buy milk',
            },
            assertions: [],
          },
          {
            id: 'create-todo',
            title: 'Create TODO',
            action: { kind: 'click', locator: { by: 'role', role: 'button', name: 'Add' } },
            assertions: [
              {
                kind: 'containsText',
                locator: { by: 'text', text: 'Buy milk' },
                expected: 'Buy milk',
              },
            ],
          },
          {
            id: 'list-todos',
            title: 'List TODOs after create',
            action: { kind: 'goto', path: '/' },
            assertions: [
              {
                kind: 'containsText',
                locator: { by: 'text', text: 'Buy milk' },
                expected: 'Buy milk',
              },
            ],
          },
          {
            id: 'reload-todos',
            title: 'Reload TODOs',
            action: { kind: 'goto', path: '/' },
            assertions: [
              {
                kind: 'containsText',
                locator: { by: 'text', text: 'Buy milk' },
                expected: 'Buy milk',
              },
            ],
          },
        ],
      },
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    },
    createdBy: 'validation-evidence-test',
    runId,
    stepRunId: `evidence-step-${index}`,
    attemptId: `evidence-attempt-${index}`,
  });
  const browserPlanReference = {
    name: browserPlan.metadata.name,
    revision: browserPlan.metadata.revision,
    sha256: browserPlan.metadata.sha256,
  };
  for (const [gate, name] of [
    ['plan-approved', 'plan.current'],
    ['implementation-generated', 'implementation.report'],
    ['deterministic-checks', 'verification.report'],
    ['browser-acceptance', 'browser-verification.report'],
    ['terminal-run', 'terminal.evidence'],
  ] as const) {
    const content =
      name === 'verification.report'
        ? {
            schemaVersion: '1' as const,
            approved: true,
            packageManager: 'npm' as const,
            summary: 'Smoke passed.',
            commands: [
              {
                name: 'database-row-match',
                command: 'npm',
                args: ['run', 'smoke'],
                exitCode: 0,
                durationMs: 1,
                stdout: `AGENT_FOUNDRY_DB_MATCH:${'a'.repeat(64)}`,
                stderr: '',
                skipped: false,
                advisory: false,
              },
            ],
            createdAt: now,
          }
        : name === 'browser-verification.report'
          ? {
              schemaVersion: '1' as const,
              approved: true,
              summary: 'Browser verification passed.',
              planArtifact: browserPlanReference,
              previewSession: {
                sessionId: 'preview-1',
                status: 'running' as const,
                url: 'http://127.0.0.1:3000/',
                evidence: { screenshots: [] },
              },
              steps: [
                {
                  stepId: 'open-todos',
                  title: 'Open TODO list',
                  status: 'passed' as const,
                  durationMs: 1,
                  observations: [],
                },
                {
                  stepId: 'fill-todo',
                  title: 'Fill TODO title',
                  status: 'passed' as const,
                  durationMs: 1,
                  observations: [],
                },
                {
                  stepId: 'create-todo',
                  title: 'Create TODO',
                  status: 'passed' as const,
                  durationMs: 1,
                  observations: [],
                },
                {
                  stepId: 'list-todos',
                  title: 'List TODOs after create',
                  status: 'passed' as const,
                  durationMs: 1,
                  observations: [],
                },
                {
                  stepId: 'reload-todos',
                  title: 'Reload TODOs',
                  status: 'passed' as const,
                  durationMs: 1,
                  observations: [],
                },
              ],
            }
          : name === 'plan.current'
            ? {
                schemaVersion: '1' as const,
                status: 'completed' as const,
                summary: 'Three-task TODO plan.',
                data: {
                  schemaVersion: '1' as const,
                  modules: [{ id: 'crud:todos', acceptanceChannel: 'browser-visible' as const }],
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                      module: 'crud:todos',
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                      module: 'crud:todos',
                    },
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
            : { approved: true };
    const artifact = await runtime.artifacts.put({
      projectId: run.projectId,
      name,
      content,
      createdBy: 'validation-evidence-test',
      runId,
      ...(name === 'implementation.report' || name === 'browser-verification.report'
        ? { stepRunId: `evidence-step-${index}`, attemptId: `evidence-attempt-${index}` }
        : {}),
    });
    proofs[gate] = {
      runId,
      ...(artifact.metadata.stepRunId ? { stepRunId: artifact.metadata.stepRunId } : {}),
      ...(artifact.metadata.attemptId ? { attemptId: artifact.metadata.attemptId } : {}),
      artifact: {
        name: artifact.metadata.name,
        revision: artifact.metadata.revision,
        sha256: artifact.metadata.sha256,
      },
    };
  }
  const browserProof = proofs['browser-acceptance'];
  if (!browserProof?.artifact) throw new Error('missing browser evidence proof');
  const attempt = await runtime.stepAttempts.get(
    run.id,
    `evidence-step-${index}`,
    `evidence-attempt-${index}`,
  );
  if (!attempt) throw new Error('missing browser source attempt');
  await runtime.stepAttempts.update(
    {
      ...attempt,
      previewSessionId: 'preview-1',
      inputArtifacts: [browserPlanReference],
      outputArtifacts: [proofs['implementation-generated']!.artifact!, browserProof.artifact],
      updatedAt: now,
    },
    attempt.version,
  );
  await runtime.events.append({
    id: `evidence-approval-${index}`,
    projectId: run.projectId,
    runId,
    type: 'run.approval_decided',
    createdAt: now,
    message: 'Plan approved',
    data: { action: 'approve', reviewedArtifact: proofs['plan-approved']?.artifact },
  });
  await runtime.events.append({
    id: `evidence-provisioned-${index}`,
    projectId: run.projectId,
    runId,
    type: 'project.provisioned',
    createdAt: now,
    message: 'Project provisioned',
    data: {},
  });
  for (const [suffix, artifactName] of [
    ['verification', 'verification.report'],
    ['browser', 'browser-verification.report'],
  ] as const) {
    await runtime.events.append({
      id: `evidence-${suffix}-${index}`,
      projectId: run.projectId,
      runId,
      type: 'verification.completed',
      createdAt: now,
      message: 'Verification passed',
      data: {
        approved: true,
        artifactName,
        artifact:
          proofs[
            artifactName === 'verification.report' ? 'deterministic-checks' : 'browser-acceptance'
          ]?.artifact,
      },
    });
  }
  proofs['preview-healthy'] = proofs['browser-acceptance'];
  const databaseArtifact = await runtime.artifacts.put({
    projectId: run.projectId,
    name: 'database.evidence',
    content: {
      schemaVersion: '1',
      status: 'matched',
      verification: 'create-list-reload',
      rowFingerprint: 'a'.repeat(64),
      browserArtifact: proofs['browser-acceptance']?.artifact,
      verificationArtifact: proofs['deterministic-checks']?.artifact,
      checkedAt: now,
    },
    createdBy: 'validation-evidence-test',
    runId,
    stepRunId: `evidence-step-${index}`,
    attemptId: `evidence-attempt-${index}`,
  });
  const browserAttempt = await runtime.stepAttempts.get(
    run.id,
    `evidence-step-${index}`,
    `evidence-attempt-${index}`,
  );
  if (!browserAttempt) throw new Error('missing updated browser source attempt');
  await runtime.stepAttempts.update(
    {
      ...browserAttempt,
      outputArtifacts: [
        ...browserAttempt.outputArtifacts,
        {
          name: databaseArtifact.metadata.name,
          revision: databaseArtifact.metadata.revision,
          sha256: databaseArtifact.metadata.sha256,
        },
      ],
      updatedAt: now,
    },
    browserAttempt.version,
  );
  proofs['database-match'] = {
    runId,
    ...(databaseArtifact.metadata.stepRunId
      ? { stepRunId: databaseArtifact.metadata.stepRunId }
      : {}),
    ...(databaseArtifact.metadata.attemptId
      ? { attemptId: databaseArtifact.metadata.attemptId }
      : {}),
    artifact: {
      name: databaseArtifact.metadata.name,
      revision: databaseArtifact.metadata.revision,
      sha256: databaseArtifact.metadata.sha256,
    },
  };
  for (const [suffix, proof] of [
    ['implementation', proofs['implementation-generated']],
    ['verification', proofs['deterministic-checks']],
    ['browser', proofs['browser-acceptance']],
    ['database', proofs['database-match']],
  ] as const) {
    if (!proof) throw new Error(`missing ${suffix} evidence proof`);
    if (!proof.artifact) throw new Error(`missing ${suffix} artifact reference`);
    await runtime.events.append({
      id: `evidence-artifact-${suffix}-${index}`,
      projectId: run.projectId,
      runId,
      type: 'artifact.created',
      createdAt: now,
      message: 'Evidence artifact created',
      data: proof.artifact,
    });
  }
  return proofs;
}

function publication(
  runId: string,
  outcome: 'accepted' | 'product-failed' | 'model-failed' | 'environment-blocked',
  proofs: EvidenceProofs = {},
) {
  const failed = outcome !== 'accepted';
  return {
    environmentReadiness: {
      status: outcome === 'environment-blocked' ? 'environment-blocked' : 'passed',
      environmentId: 'environment-1',
      checks: [
        {
          boundary: 'docker',
          status: outcome === 'environment-blocked' ? 'failed' : 'passed',
          durationMs: 1,
          message: 'user: SELECT password FROM users at /Users/edsilva/private/db',
        },
      ],
    },
    gates: [
      ['project-created', 'passed'],
      ['plan-approved', 'passed'],
      ['implementation-generated', 'passed'],
      [
        'deterministic-checks',
        failed ? 'failed' : 'passed',
        outcome === 'model-failed' ? 'model' : 'product',
      ],
      ['preview-healthy', 'passed'],
      ['browser-acceptance', 'passed'],
      ['database-match', 'passed'],
      ['terminal-run', 'passed'],
    ]
      .map(([id, status, failureClass]) => ({
        id,
        status,
        ...(status === 'failed' ? { failureClass } : {}),
        references: [id ? (proofs[id] ?? { runId }) : { runId }],
        ...(status === 'failed' ? { summary: 'Contact alice@example.com for help' } : {}),
      }))
      .map((gate) => ({
        ...gate,
        references: gate.references,
      })),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('validation evidence API', () => {
  it('publishes terminal evidence after the public project workflow reaches a terminal state', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'validation-evidence-workflow-'));
    directories.push(dataDir);
    const runtime = await createRuntime(
      {
        ...process.env,
        REPO_ROOT: resolve(import.meta.dirname, '../../..'),
        DATA_DIR: dataDir,
        WORKFLOWS_DIR: resolve(import.meta.dirname, '../../../workflows'),
        EXECUTOR_MODE: 'real',
        VALIDATION_CAMPAIGN: 'real-todo-v1',
        CODEX_DEFAULT_MODEL: 'gpt-5.6-luna',
        CLAUDE_FAST_MODEL: 'claude-haiku-4-5-20251001',
        WORKER_ID: 'validation-evidence-public-workflow',
      } as NodeJS.ProcessEnv,
      undefined,
      undefined,
      {
        generatedProjectRuntime: null,
        executors: createValidationCampaignTestExecutorRegistry(),
        disablePreviews: true,
        validationPreflight: controlledValidationPreflight,
      },
    );
    if (!runtime.runValidationPreflight) throw new Error('validation preflight is unavailable');
    await runtime.runValidationPreflight();
    const app = await buildApp(runtime);
    apps.push(app);
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        name: 'Public validation workflow',
        prd: 'Create a small TODO application with persistent storage and a visible list.',
        workflowId: 'web-app-v1',
      },
    });
    expect(projectResponse.statusCode).toBe(202);
    const project = projectResponse.json().project;
    const runId = project.currentRunId!;

    expect(await runtime.worker.runOnce()).toBe(true);
    // Approving the plan runs the schema step and parks on its own gate (#481).
    for (const nodeId of ['plan-approval', 'schema-approval']) {
      const pending = (await runtime.projectService.listApprovals(runId)).find(
        (entry) => !entry.decision,
      );
      expect(pending?.request.nodeId).toBe(nodeId);
      const decision = await app.inject({
        method: 'POST',
        url: `/runs/${runId}/approvals/${pending!.request.id}/decide`,
        payload: { action: 'approve', decidedBy: 'public-workflow-test' },
      });
      expect(decision.statusCode).toBe(202);
      expect(await runtime.worker.runOnce()).toBe(true);
    }

    const evidence = await app.inject({
      method: 'GET',
      url: `/runs/${runId}/validation-evidence`,
    });
    expect(evidence.statusCode).toBe(200);
    // This harness builds the API with `inject` and sets `disablePreviews`, so
    // nothing ever serves the preview origin — the run is #526 reproduced in a
    // test. It used to reach a terminal state as `product-failed`: the browser
    // check failed, the repair loop claimed it, and a dead preview was
    // published to the campaign bundle as a defect in the generated app. That
    // misattribution is exactly what #528 removes, so the honest terminal
    // outcome here is `environment-blocked`, with
    // `terminalState.error.name === 'BrowserInfrastructureError'`. The four
    // outcomes themselves, `product-failed` included, stay covered by the
    // sibling test below.
    expect(evidence.json().bundle.outcome).toBe('environment-blocked');
    expect(evidence.json().bundle.terminalState.error.name).toBe('BrowserInfrastructureError');
  }, 120_000);

  it('publishes all four outcomes, redacts evidence, and replays the same artifact', async () => {
    const runtime = await createEvidenceRuntime();
    const app = await buildApp(runtime);
    apps.push(app);

    let acceptedRunId: string | undefined;
    for (const [index, outcome] of (
      ['accepted', 'product-failed', 'model-failed', 'environment-blocked'] as const
    ).entries()) {
      const runId = await createRun(runtime, app, index, outcome);
      const proofs = outcome === 'accepted' ? await seedAcceptedProof(runtime, runId, index) : {};
      if (outcome === 'accepted') {
        const acceptance = await app.inject({
          method: 'POST',
          url: `/runs/${runId}/validation-acceptance`,
          payload: {
            decidedBy: 'public-workflow-test',
            browserArtifact: proofs['browser-acceptance']?.artifact,
            databaseArtifact: proofs['database-match']?.artifact,
          },
        });
        expect(acceptance.statusCode).toBe(202);
      }
      const response = await app.inject({
        method: 'POST',
        url: `/runs/${runId}/validation-evidence`,
        payload: publication(runId, outcome, proofs),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().bundle.outcome).toBe(outcome);
      expect(response.json()).not.toHaveProperty('bundle.environmentReadiness.dataDirectory');
      expect(JSON.stringify(response.json())).not.toContain('top-secret-value');
      expect(JSON.stringify(response.json())).not.toContain('password');
      expect(JSON.stringify(response.json())).not.toContain('SELECT password');
      expect(JSON.stringify(response.json())).not.toContain('alice@example.com');
      expect(JSON.stringify(response.json())).not.toContain('todo-1');
      expect(JSON.stringify(response.json())).not.toContain('sk-test-secret');

      if (outcome === 'accepted') {
        acceptedRunId = runId;
        const replay = await app.inject({
          method: 'POST',
          url: `/runs/${runId}/validation-evidence`,
          payload: publication(runId, outcome, proofs),
        });
        expect(replay.json().artifact.metadata.revision).toBe(
          response.json().artifact.metadata.revision,
        );
        const readBack = await app.inject({
          method: 'GET',
          url: `/runs/${runId}/validation-evidence`,
        });
        expect(readBack.statusCode).toBe(200);
        expect(readBack.json().bundle.outcome).toBe('accepted');
      }
    }

    const readBack = await app.inject({
      method: 'GET',
      url: `/runs/${acceptedRunId}/validation-evidence`,
    });
    expect(readBack.statusCode).toBe(200);
    expect(readBack.json().bundle.outcome).toBe('accepted');
  });
});
