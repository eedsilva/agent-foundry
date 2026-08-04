import { describe, expect, it } from 'vitest';
import {
  createValidationCampaignExecution,
  ValidationCampaignPreviewSchema,
  type ArtifactReference,
  type ValidationEvidencePublicationRequest,
} from '@agent-foundry/contracts';
import { makeHarness, MODELS, seedRun } from './testing/harness.js';
import { ValidationEvidenceService } from './validation-evidence.js';

const campaign = ValidationCampaignPreviewSchema.parse({
  schemaVersion: '1',
  id: 'real-todo-v1',
  name: 'Real TODO validation campaign',
  sourceRevision: 'a'.repeat(40),
  allowedModels: [
    { id: 'model-1', provider: 'codex', model: 'test-model' },
    { id: 'model-2', provider: 'codex', model: 'alt-model' },
    { id: 'model-3', provider: 'claude', model: 'haiku' },
  ],
  routes: [
    {
      taskKind: 'planning',
      selected: { id: 'model-1', provider: 'codex', model: 'test-model' },
      fallbacks: [],
    },
  ],
  limits: {
    attemptsPerAgentStep: 1,
    targetedRepairs: 1,
    activeTimeMinutes: 45,
    meteredCostUsd: 2,
  },
});

const reference = { runId: 'run-1' };

function request(
  outcome: 'accepted' | 'product-failed' | 'model-failed' | 'environment-blocked',
  proofs: Partial<Record<string, ArtifactReference>> = {},
): ValidationEvidencePublicationRequest {
  const gateStatus = outcome === 'accepted' ? 'passed' : 'failed';
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
      {
        id: 'project-created',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['project-created'] ? { artifact: proofs['project-created'] } : {}),
          },
        ],
      },
      {
        id: 'plan-approved',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['plan-approved'] ? { artifact: proofs['plan-approved'] } : {}),
          },
        ],
      },
      {
        id: 'implementation-generated',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['implementation-generated']
              ? { artifact: proofs['implementation-generated'] }
              : {}),
          },
        ],
      },
      {
        id: 'deterministic-checks',
        status: gateStatus,
        failureClass: outcome === 'model-failed' ? 'model' : 'product',
        references: [
          {
            ...reference,
            ...(proofs['deterministic-checks'] ? { artifact: proofs['deterministic-checks'] } : {}),
          },
        ],
        summary: 'Authorization: bearer top-secret-value at /Users/edsilva/private/todo',
      },
      {
        id: 'preview-healthy',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['preview-healthy'] ? { artifact: proofs['preview-healthy'] } : {}),
          },
        ],
      },
      {
        id: 'browser-acceptance',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['browser-acceptance'] ? { artifact: proofs['browser-acceptance'] } : {}),
          },
        ],
      },
      {
        id: 'database-match',
        status: 'passed',
        references: [
          {
            ...reference,
            ...(proofs['database-match'] ? { artifact: proofs['database-match'] } : {}),
          },
        ],
      },
      {
        id: 'terminal-run',
        status: 'passed',
        references: [
          { ...reference, ...(proofs['terminal-run'] ? { artifact: proofs['terminal-run'] } : {}) },
        ],
      },
    ],
  };
}

async function setup() {
  const harness = makeHarness({}, undefined, { validationCampaign: campaign });
  await seedRun(harness);
  const now = harness.clock.now().toISOString();
  const run = await harness.runs.get('run-1');
  if (!run) throw new Error('run-1 was not seeded');
  await harness.runs.update(
    {
      ...run,
      status: 'completed',
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      execution: {
        activeElapsedMs: 12,
        consecutiveRepairs: 0,
        campaign: createValidationCampaignExecution(campaign),
      },
    },
    run.version,
  );
  await harness.stepRuns.create({
    id: 'step-1',
    runId: 'run-1',
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
  await harness.stepAttempts.create({
    id: 'attempt-1',
    runId: 'run-1',
    stepRunId: 'step-1',
    sequence: 1,
    executorKind: 'agent',
    provider: 'codex',
    model: 'test-model',
    modelId: 'model-1',
    status: 'succeeded',
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    durationMs: 12,
    usage: { providerReportedCostUsd: 0.1 },
    checkpoint: 'checkpoint-1',
    context: {
      projectId: 'project-1',
      workflowId: harness.workflow.id,
      nodeId: 'plan',
      stepId: 'plan',
    },
    inputArtifacts: [],
    outputArtifacts: [],
  });
  const proofs: Partial<Record<string, ArtifactReference>> = {};
  for (const name of [
    'prd',
    'plan.current',
    'implementation.report',
    'verification.report',
    'browser-verification.report',
    'database.evidence',
    'terminal.evidence',
  ]) {
    const artifact = await harness.artifacts.put({
      projectId: 'project-1',
      name,
      content: name === 'database.evidence' ? { status: 'matched' } : { approved: true },
      createdBy: 'validation-test',
      ...(name === 'prd' ? {} : { runId: 'run-1' }),
    });
    const proof = {
      name: artifact.metadata.name,
      revision: artifact.metadata.revision,
      sha256: artifact.metadata.sha256,
    };
    const gate =
      name === 'prd'
        ? 'project-created'
        : name === 'plan.current'
          ? 'plan-approved'
          : name === 'implementation.report'
            ? 'implementation-generated'
            : name === 'verification.report'
              ? 'deterministic-checks'
              : name === 'browser-verification.report'
                ? 'browser-acceptance'
                : name === 'database.evidence'
                  ? 'database-match'
                  : name === 'terminal.evidence'
                    ? 'terminal-run'
                    : undefined;
    if (gate) {
      proofs[gate] = proof;
    }
    if (name === 'browser-verification.report') {
      proofs['preview-healthy'] = proof;
    }
  }
  await harness.events.append({
    id: 'event-project-created',
    projectId: 'project-1',
    type: 'project.created',
    createdAt: now,
    message: 'Project created',
    data: {},
  });
  await harness.events.append({
    id: 'event-approval',
    projectId: 'project-1',
    runId: 'run-1',
    type: 'run.approval_decided',
    createdAt: now,
    message: 'Plan approved',
    data: { action: 'approve' },
  });
  await harness.events.append({
    id: 'event-provisioned',
    projectId: 'project-1',
    runId: 'run-1',
    type: 'project.provisioned',
    createdAt: now,
    message: 'Project provisioned',
    data: {},
  });
  for (const [id, artifactName] of [
    ['event-verification', 'verification.report'],
    ['event-browser', 'browser-verification.report'],
  ] as const) {
    await harness.events.append({
      id,
      projectId: 'project-1',
      runId: 'run-1',
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
  const evidence = new ValidationEvidenceService(
    harness.runs,
    harness.stepRuns,
    harness.stepAttempts,
    harness.artifacts,
    MODELS,
    harness.events,
  );
  return { harness, evidence, proofs };
}

describe('validation evidence publication', () => {
  it('does not accept caller labels without persisted gate proofs', async () => {
    const { evidence } = await setup();

    await expect(evidence.publish('run-1', request('accepted'))).rejects.toThrow(
      'persisted runtime evidence',
    );
  });

  it('classifies an accepted run and is idempotent while redacting persisted evidence', async () => {
    const { harness, evidence, proofs } = await setup();
    const first = await evidence.publish('run-1', request('accepted', proofs));
    const second = await evidence.publish('run-1', request('accepted', proofs));

    expect(first.bundle.outcome).toBe('accepted');
    expect(second.artifact.metadata.revision).toBe(first.artifact.metadata.revision);
    expect(harness.artifacts.named('validation-evidence-real-todo-v1')).toHaveLength(1);
    expect(JSON.stringify(first.bundle)).not.toContain('password');
    expect(JSON.stringify(first.bundle)).not.toContain('top-secret-value');
    expect(JSON.stringify(first.bundle)).not.toContain('/Users/edsilva');
    expect(JSON.stringify(first.bundle)).not.toContain('SELECT password');
  });

  it('publishes an automatic terminal bundle when preflight evidence is unavailable', async () => {
    const { evidence } = await setup();

    const result = await evidence.publishFromRun('run-1');

    expect(result?.bundle.outcome).toBe('environment-blocked');
  });

  it.each(['product-failed', 'model-failed', 'environment-blocked'] as const)(
    'classifies %s without reporting acceptance',
    async (outcome) => {
      const { evidence } = await setup();
      const result = await evidence.publish('run-1', request(outcome));

      expect(result.bundle.outcome).toBe(outcome);
    },
  );
});
