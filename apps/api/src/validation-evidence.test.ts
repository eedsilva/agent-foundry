import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createValidationCampaignExecution,
  type ArtifactReference,
} from '@agent-foundry/contracts';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const directories: string[] = [];

async function createEvidenceRuntime(): Promise<Runtime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'validation-evidence-data-'));
  directories.push(dataDir);
  return createRuntime(
    {
      ...process.env,
      REPO_ROOT: resolve(import.meta.dirname, '../../..'),
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: resolve(import.meta.dirname, '../../../workflows'),
      EXECUTOR_MODE: 'real',
      VALIDATION_CAMPAIGN: 'real-todo-v1',
      CODEX_DEFAULT_MODEL: 'gpt-5.6-luna',
      WORKER_ID: 'validation-evidence-worker',
    } as NodeJS.ProcessEnv,
    undefined,
    undefined,
    { generatedProjectRuntime: null },
  );
}

async function createRun(runtime: Runtime, index: number): Promise<string> {
  const project = await runtime.projectService.create({
    name: `Evidence ${index}`,
    prd: 'Create a small TODO application with persistent storage and a visible list.',
    workflowId: 'web-app-v1',
  });
  const run = await runtime.runs.get(project.currentRunId!);
  if (!run || !runtime.validationCampaign) throw new Error('validation run was not created');
  const now = new Date().toISOString();
  await runtime.runs.update(
    {
      ...run,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      execution: {
        activeElapsedMs: 1,
        consecutiveRepairs: 0,
        campaign: createValidationCampaignExecution(runtime.validationCampaign),
      },
    },
    run.version,
  );
  const stepRunId = `evidence-step-${index}`;
  await runtime.stepRuns.create({
    id: stepRunId,
    runId: run.id,
    nodeId: 'plan',
    stepId: 'plan',
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
    context: {
      projectId: project.id,
      workflowId: project.workflowId,
      nodeId: 'plan',
      stepId: 'plan',
    },
    inputArtifacts: [],
    outputArtifacts: [],
  });
  return run.id;
}

type EvidenceProofs = Partial<Record<string, ArtifactReference>>;

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
      name: projectArtifact.metadata.name,
      revision: projectArtifact.metadata.revision,
      sha256: projectArtifact.metadata.sha256,
    },
  };
  for (const [gate, name] of [
    ['plan-approved', 'plan.current'],
    ['implementation-generated', 'implementation.report'],
    ['deterministic-checks', 'verification.report'],
    ['preview-healthy', 'browser-verification.report'],
    ['browser-acceptance', 'browser-verification.report'],
    ['database-match', 'database.evidence'],
    ['terminal-run', 'terminal.evidence'],
  ] as const) {
    const artifact = await runtime.artifacts.put({
      projectId: run.projectId,
      name,
      content: name === 'database.evidence' ? { status: 'matched' } : { approved: true },
      createdBy: 'validation-evidence-test',
      runId,
    });
    proofs[gate] = {
      name: artifact.metadata.name,
      revision: artifact.metadata.revision,
      sha256: artifact.metadata.sha256,
    };
  }
  await runtime.events.append({
    id: `evidence-approval-${index}`,
    projectId: run.projectId,
    runId,
    type: 'run.approval_decided',
    createdAt: now,
    message: 'Plan approved',
    data: { action: 'approve' },
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
          ],
      },
    });
  }
  return proofs;
}

function publication(runId: string, outcome: string, proofs: EvidenceProofs = {}) {
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
        references: [{ runId }],
        ...(status === 'failed' ? { summary: 'Authorization: bearer top-secret-value' } : {}),
      }))
      .map((gate) => ({
        ...gate,
        references: [
          {
            runId,
            ...(gate.id && proofs[gate.id] ? { artifact: proofs[gate.id] } : {}),
          },
        ],
      })),
  };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('validation evidence API', () => {
  it('publishes all four outcomes, redacts evidence, and replays the same artifact', async () => {
    const runtime = await createEvidenceRuntime();
    const app = await buildApp(runtime);
    apps.push(app);

    let acceptedRunId: string | undefined;
    for (const [index, outcome] of [
      'accepted',
      'product-failed',
      'model-failed',
      'environment-blocked',
    ].entries()) {
      const runId = await createRun(runtime, index);
      const proofs = outcome === 'accepted' ? await seedAcceptedProof(runtime, runId, index) : {};
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
