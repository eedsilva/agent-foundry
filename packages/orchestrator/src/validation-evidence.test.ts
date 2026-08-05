import { describe, expect, it, vi } from 'vitest';
import {
  createValidationCampaignExecution,
  ValidationCampaignPreviewSchema,
  WorkflowDefinitionSchema,
  type ValidationEvidenceReference,
  type ValidationEvidencePublicationRequest,
  type ValidationPreflightReport,
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
  proofs: Partial<Record<string, ValidationEvidenceReference>> = {},
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
        references: [proofs['project-created'] ?? reference],
      },
      {
        id: 'plan-approved',
        status: 'passed',
        references: [proofs['plan-approved'] ?? reference],
      },
      {
        id: 'implementation-generated',
        status: 'passed',
        references: [proofs['implementation-generated'] ?? reference],
      },
      {
        id: 'deterministic-checks',
        status: gateStatus,
        failureClass: outcome === 'model-failed' ? 'model' : 'product',
        references: [proofs['deterministic-checks'] ?? reference],
        summary: 'Authorization: bearer top-secret-value at /Users/edsilva/private/todo',
      },
      {
        id: 'preview-healthy',
        status: 'passed',
        references: [proofs['preview-healthy'] ?? reference],
      },
      {
        id: 'browser-acceptance',
        status: 'passed',
        references: [proofs['browser-acceptance'] ?? reference],
      },
      {
        id: 'database-match',
        status: 'passed',
        references: [proofs['database-match'] ?? reference],
      },
      {
        id: 'terminal-run',
        status: 'passed',
        references: [proofs['terminal-run'] ?? reference],
      },
    ],
  };
}

async function setup(
  options: {
    withPreflight?: boolean;
    preflightChecks?: ValidationPreflightReport['checks'];
  } = {},
) {
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
    const stepRunId = `step-${taskIndex}`;
    const attemptId = `attempt-${taskIndex}`;
    await harness.stepRuns.create({
      id: stepRunId,
      runId: 'run-1',
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
    await harness.stepAttempts.create({
      id: attemptId,
      runId: 'run-1',
      stepRunId,
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
      checkpoint: `checkpoint-${taskId}`,
      context: {
        projectId: 'project-1',
        workflowId: harness.workflow.id,
        nodeId: 'implement',
        stepId: `implement.${taskId}`,
      },
      inputArtifacts: [],
      outputArtifacts: [],
    });
  }
  const proofs: Partial<Record<string, ValidationEvidenceReference>> = {};
  const browserPlan = await harness.artifacts.put({
    projectId: 'project-1',
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
    createdBy: 'validation-test',
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
  });
  const browserPlanReference = {
    name: browserPlan.metadata.name,
    revision: browserPlan.metadata.revision,
    sha256: browserPlan.metadata.sha256,
  };
  for (const name of [
    'prd',
    'plan.current',
    'implementation.report',
    'verification.report',
    'browser-verification.report',
    'terminal.evidence',
  ]) {
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
                  tasks: [
                    {
                      id: 'persistent-storage',
                      title: 'Persist TODOs',
                      dependsOn: [],
                      deliverables: ['persistent TODO storage'],
                      acceptanceCheck: 'TODOs survive reload.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'create-list-api',
                      title: 'Create and list TODOs through the API',
                      dependsOn: ['persistent-storage'],
                      deliverables: ['create/list API behavior'],
                      acceptanceCheck: 'The API returns the stored TODO.',
                      acceptanceMode: 'deterministic-only' as const,
                    },
                    {
                      id: 'visible-todo-flow',
                      title: 'Create, list, and reload a TODO visibly',
                      dependsOn: ['create-list-api'],
                      deliverables: ['visible create/list/reload behavior'],
                      acceptanceCheck: 'A user can create, list, and reload a TODO.',
                      acceptanceMode: 'browser-visible' as const,
                    },
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
            : { approved: true };
    const artifact = await harness.artifacts.put({
      projectId: 'project-1',
      name,
      content,
      createdBy: 'validation-test',
      ...(name === 'prd' ? {} : { runId: 'run-1' }),
      ...(name === 'implementation.report' || name === 'browser-verification.report'
        ? { stepRunId: 'step-1', attemptId: 'attempt-1' }
        : {}),
    });
    const proof: ValidationEvidenceReference = {
      runId: 'run-1',
      ...(artifact.metadata.stepRunId ? { stepRunId: artifact.metadata.stepRunId } : {}),
      ...(artifact.metadata.attemptId ? { attemptId: artifact.metadata.attemptId } : {}),
      artifact: {
        name: artifact.metadata.name,
        revision: artifact.metadata.revision,
        sha256: artifact.metadata.sha256,
      },
    };
    const gate = {
      prd: 'project-created',
      'plan.current': 'plan-approved',
      'implementation.report': 'implementation-generated',
      'verification.report': 'deterministic-checks',
      'browser-verification.report': 'browser-acceptance',
      'terminal.evidence': 'terminal-run',
    }[name];
    if (gate) {
      proofs[gate] = proof;
    }
    if (name === 'browser-verification.report') {
      proofs['preview-healthy'] = proof;
    }
  }
  const browserProof = proofs['browser-acceptance'];
  if (!browserProof?.artifact) throw new Error('missing browser evidence proof');
  const attempt = await harness.stepAttempts.get('run-1', 'step-1', 'attempt-1');
  if (!attempt) throw new Error('missing browser source attempt');
  await harness.stepAttempts.update(
    {
      ...attempt,
      previewSessionId: 'preview-1',
      inputArtifacts: [browserPlanReference],
      outputArtifacts: [proofs['implementation-generated']!.artifact!, browserProof.artifact],
      updatedAt: now,
    },
    attempt.version,
  );
  const databaseArtifact = await harness.artifacts.put({
    projectId: 'project-1',
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
    createdBy: 'validation-test',
    runId: 'run-1',
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
  });
  const updatedAttempt = await harness.stepAttempts.get('run-1', 'step-1', 'attempt-1');
  if (!updatedAttempt) throw new Error('missing updated browser source attempt');
  await harness.stepAttempts.update(
    {
      ...updatedAttempt,
      outputArtifacts: [
        ...updatedAttempt.outputArtifacts,
        {
          name: databaseArtifact.metadata.name,
          revision: databaseArtifact.metadata.revision,
          sha256: databaseArtifact.metadata.sha256,
        },
      ],
      updatedAt: now,
    },
    updatedAttempt.version,
  );
  proofs['database-match'] = {
    runId: 'run-1',
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
    await harness.events.append({
      id: `event-artifact-${suffix}`,
      projectId: 'project-1',
      runId: 'run-1',
      type: 'artifact.created',
      createdAt: now,
      message: 'Evidence artifact created',
      data: proof.artifact,
    });
  }
  await harness.events.append({
    id: 'event-project-created',
    projectId: 'project-1',
    runId: 'run-1',
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
    data: { action: 'approve', reviewedArtifact: proofs['plan-approved']?.artifact },
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
          ]?.artifact,
      },
    });
  }
  await harness.events.append({
    id: 'event-operator-accepted',
    projectId: 'project-1',
    runId: 'run-1',
    type: 'validation.operator_accepted',
    createdAt: now,
    message: 'Operator accepted the visible TODO and matching database row.',
    data: {
      decidedBy: 'validation-test-operator',
      browserArtifact: proofs['browser-acceptance']?.artifact,
      databaseArtifact: proofs['database-match']?.artifact,
    },
  });
  const evidence = new ValidationEvidenceService(
    harness.runs,
    harness.stepRuns,
    harness.stepAttempts,
    harness.artifacts,
    MODELS,
    harness.events,
    async () =>
      options.withPreflight === false
        ? undefined
        : {
            schemaVersion: '1' as const,
            campaignId: campaign.id,
            sourceRevision: campaign.sourceRevision,
            dataDirectory: '/tmp/validation-evidence-test',
            executorMode: 'real' as const,
            environmentId: 'validation-preflight-test',
            startedAt: now,
            completedAt: now,
            status: (options.preflightChecks?.some((check) => check.status === 'failed')
              ? 'environment-blocked'
              : 'passed') as 'passed' | 'environment-blocked',
            checks: options.preflightChecks ?? [
              { boundary: 'source-revision' as const, status: 'passed' as const, durationMs: 1 },
            ],
            generatedProjectCreated: false as const,
          },
  );
  return { harness, evidence, proofs };
}

describe('validation evidence publication', () => {
  it('creates production database evidence from the campaign verification seam', async () => {
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: '1',
      id: 'validation-verification-v1',
      name: 'Validation verification',
      description: 'One blocking verification step.',
      stack: 'node',
      nodes: [
        {
          id: 'full-suite-verification',
          type: 'verify',
          title: 'Full suite',
          outputArtifact: 'verification.report',
          scripts: [],
          blocksOnFailure: true,
        },
      ],
    });
    const harness = makeHarness({}, undefined, {
      workflow,
      validationCampaign: campaign,
      verification: () => ({
        schemaVersion: '1',
        approved: true,
        packageManager: 'npm',
        summary: 'Verification passed.',
        commands: [
          {
            name: 'database-row-match',
            command: 'npm',
            args: ['run', 'database-row-match'],
            exitCode: 0,
            durationMs: 1,
            stdout: `AGENT_FOUNDRY_DB_MATCH:${'b'.repeat(64)}`,
            stderr: '',
            skipped: false,
            advisory: false,
          },
        ],
        createdAt: new Date().toISOString(),
      }),
    });
    await seedRun(harness);
    const browserPlan = await harness.artifacts.put({
      projectId: 'project-1',
      name: 'browser-test.plan',
      content: {
        schemaVersion: '1',
        status: 'completed',
        summary: 'Browser plan.',
        data: {
          schemaVersion: '1',
          id: 'todo-flow',
          title: 'TODO flow',
          viewport: { width: 1280, height: 720 },
          steps: [
            { id: 'create', title: 'Create', action: { kind: 'goto', path: '/' }, assertions: [] },
            { id: 'list', title: 'List', action: { kind: 'goto', path: '/' }, assertions: [] },
            { id: 'reload', title: 'Reload', action: { kind: 'goto', path: '/' }, assertions: [] },
          ],
        },
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      },
      createdBy: 'test',
      runId: 'run-1',
    });
    const browserArtifact = await harness.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      content: {
        schemaVersion: '1',
        approved: true,
        summary: 'Browser passed.',
        planArtifact: {
          name: browserPlan.metadata.name,
          revision: browserPlan.metadata.revision,
          sha256: browserPlan.metadata.sha256,
        },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          url: 'http://127.0.0.1:3000/',
          evidence: { screenshots: [] },
        },
        steps: [
          { stepId: 'create', title: 'Create', status: 'passed', durationMs: 1, observations: [] },
          { stepId: 'list', title: 'List', status: 'passed', durationMs: 1, observations: [] },
          { stepId: 'reload', title: 'Reload', status: 'passed', durationMs: 1, observations: [] },
        ],
      },
      createdBy: 'test',
      runId: 'run-1',
      stepRunId: 'browser-step',
      attemptId: 'browser-attempt',
    });
    const now = harness.clock.now().toISOString();
    await harness.stepRuns.create({
      id: 'browser-step',
      runId: 'run-1',
      nodeId: 'browser',
      stepId: 'browser',
      stepType: 'verify',
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    });
    await harness.stepAttempts.create({
      id: 'browser-attempt',
      runId: 'run-1',
      stepRunId: 'browser-step',
      sequence: 1,
      executorKind: 'verification',
      provider: 'internal',
      model: 'workspace-verifier',
      status: 'succeeded',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      previewSessionId: 'preview-1',
      context: {
        projectId: 'project-1',
        workflowId: workflow.id,
        nodeId: 'browser',
        stepId: 'browser',
      },
      inputArtifacts: [
        {
          name: browserPlan.metadata.name,
          revision: browserPlan.metadata.revision,
          sha256: browserPlan.metadata.sha256,
        },
      ],
      outputArtifacts: [
        {
          name: browserArtifact.metadata.name,
          revision: browserArtifact.metadata.revision,
          sha256: browserArtifact.metadata.sha256,
        },
      ],
    });
    await harness.events.append({
      id: 'browser-artifact-created',
      projectId: 'project-1',
      runId: 'run-1',
      type: 'artifact.created',
      createdAt: now,
      message: 'Browser evidence created',
      data: {
        name: browserArtifact.metadata.name,
        revision: browserArtifact.metadata.revision,
        sha256: browserArtifact.metadata.sha256,
      },
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.verifierInputs[0]?.beforeOptionalScripts).toContain('database-row-match');
    expect(harness.artifacts.named('database.evidence')).toHaveLength(1);
  });

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

  it('publishes the preflight failure cause instead of redacting it as a prompt', async () => {
    const { evidence, proofs } = await setup({
      preflightChecks: [
        {
          boundary: 'scaffold',
          status: 'failed',
          durationMs: 1,
          errorCode: 'PREFLIGHT_FAILED',
          // Ordinary ops English: "build", "create" and "app" all used to trip
          // the prompt heuristic and publish [REDACTED_PROMPT] instead.
          message:
            "scaffold prerequisite failed. Scaffold build failed. Cannot create app: ENOENT, open '/Users/rosalind/dist/sidecar.js'",
        },
      ],
    });

    const published = await evidence.publish('run-1', request('accepted', proofs));

    const check = published.bundle.environmentReadiness.checks.at(-1);
    expect(check?.message).toContain('Scaffold build failed.');
    expect(check?.message).toContain('dist/sidecar.js');
    expect(check?.message).not.toContain('rosalind');
  });

  it('still redacts a prompt-shaped preflight message', async () => {
    const { evidence, proofs } = await setup({
      preflightChecks: [
        {
          boundary: 'haiku-canary',
          status: 'failed',
          durationMs: 1,
          errorCode: 'CANARY_FAILED',
          message: 'haiku-canary did not complete. system: you are a helpful assistant',
        },
      ],
    });

    const published = await evidence.publish('run-1', request('accepted', proofs));

    expect(published.bundle.environmentReadiness.checks.at(-1)?.message).toBe('[REDACTED_PROMPT]');
  });

  it('publishes an automatic terminal bundle when preflight evidence is unavailable', async () => {
    const { evidence } = await setup({ withPreflight: false });

    const result = await evidence.publishFromRun('run-1');

    expect(result?.bundle.outcome).toBe('environment-blocked');
  });

  it.each(['product-failed', 'model-failed', 'environment-blocked'] as const)(
    'classifies %s without reporting acceptance',
    async (outcome) => {
      const { harness, evidence } = await setup();
      if (outcome !== 'product-failed') {
        const run = await harness.runs.get('run-1');
        if (!run) throw new Error('run-1 was not seeded');
        await harness.runs.update(
          {
            ...run,
            status: 'failed',
            error:
              outcome === 'model-failed'
                ? {
                    name: 'ProviderAuthenticationError',
                    message: 'provider failed',
                    code: 'PROVIDER_AUTH_FAILED',
                  }
                : {
                    name: 'EnvironmentOperationError',
                    message: 'preview failed',
                    code: 'PREVIEW_UNHEALTHY',
                  },
            updatedAt: harness.clock.now().toISOString(),
          },
          run.version,
        );
      }
      const result = await evidence.publish('run-1', request(outcome));

      expect(result.bundle.outcome).toBe(outcome);
    },
  );

  it('preserves a completed terminal run and records publication failure for retry', async () => {
    const publishFromRun = vi.fn().mockRejectedValue(new Error('evidence store unavailable'));
    const harness = makeHarness({}, undefined, {
      validationCampaign: campaign,
      validationEvidence: { publishFromRun },
    });
    await seedRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'evidence store unavailable',
    );
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(publishFromRun).toHaveBeenCalledWith('run-1');
    expect(harness.events.types()).toContain('validation.evidence_failed');
  });
});
