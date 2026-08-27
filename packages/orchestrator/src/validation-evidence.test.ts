import { describe, expect, it, vi } from 'vitest';
import {
  createValidationCampaignExecution,
  PREVIEW_INFRASTRUCTURE_ERROR_CODE,
  PREVIEW_INFRASTRUCTURE_ERROR_NAME,
  ValidationCampaignPreviewSchema,
  ValidationEvidenceBundleSchema,
  WorkflowDefinitionSchema,
  type ValidationEvidenceReference,
  type ValidationEvidencePublicationRequest,
  type ValidationPreflightReport,
} from '@agent-foundry/contracts';
import { FakeSecretStore, makeHarness, seedRun } from './testing/harness.js';
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

// Cycle-17 shape (#453): the planner asserts the pre-create empty state (fails
// advisory when an earlier round already created a row) and collapses
// list+reload into one post-create goto.
const CYCLE17_PLAN_STEPS = [
  {
    id: 'load-home',
    title: 'Load home and verify empty state',
    action: { kind: 'goto', path: '/' },
    assertions: [
      {
        kind: 'containsText',
        locator: { by: 'text', text: 'No todos yet.' },
        expected: 'No todos yet.',
      },
    ],
  },
  {
    id: 'fill-todo',
    title: 'Fill TODO title',
    action: { kind: 'fill', locator: { by: 'label', label: 'Title' }, value: 'Buy milk' },
    assertions: [],
  },
  {
    id: 'create-todo',
    title: 'Create TODO',
    action: { kind: 'click', locator: { by: 'role', role: 'button', name: 'Add' } },
    assertions: [
      { kind: 'containsText', locator: { by: 'text', text: 'Buy milk' }, expected: 'Buy milk' },
    ],
  },
  {
    id: 'reload-todos',
    title: 'Reload TODOs',
    action: { kind: 'goto', path: '/' },
    assertions: [
      { kind: 'containsText', locator: { by: 'text', text: 'Buy milk' }, expected: 'Buy milk' },
    ],
  },
];
const CYCLE17_REPORT_STEPS: Array<{
  id: string;
  title: string;
  status: 'passed' | 'failed';
  error?: string;
}> = [
  {
    id: 'load-home',
    title: 'Load home and verify empty state',
    status: 'failed' as const,
    error: 'locator.waitFor: Timeout 10000ms exceeded.',
  },
  { id: 'fill-todo', title: 'Fill TODO title', status: 'passed' as const },
  { id: 'create-todo', title: 'Create TODO', status: 'passed' as const },
  { id: 'reload-todos', title: 'Reload TODOs', status: 'passed' as const },
];

async function seedAgentAttempt(
  harness: ReturnType<typeof makeHarness>,
  now: string,
  options: {
    stepRunId: string;
    attemptId: string;
    stepId: string;
    /** The gate's real attempts-by-step key is `<nodeId>/<stepId>/<iteration>` (#589). */
    nodeId?: string;
    checkpoint?: string;
    usage?: { providerReportedCostUsd: number };
  },
): Promise<void> {
  const nodeId = options.nodeId ?? 'implement';
  await harness.stepRuns.create({
    id: options.stepRunId,
    runId: 'run-1',
    nodeId,
    stepId: options.stepId,
    stepType: 'agent',
    status: 'completed',
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
  });
  await harness.stepAttempts.create({
    id: options.attemptId,
    runId: 'run-1',
    stepRunId: options.stepRunId,
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
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    context: {
      projectId: 'project-1',
      workflowId: harness.workflow.id,
      nodeId,
      stepId: options.stepId,
    },
    inputArtifacts: [],
    outputArtifacts: [],
  });
}

async function setup(
  options: {
    withPreflight?: boolean;
    preflightChecks?: ValidationPreflightReport['checks'];
    browserPlanSteps?: typeof CYCLE17_PLAN_STEPS;
    browserReportSteps?: typeof CYCLE17_REPORT_STEPS;
    /** Run-17 shape (#398): a fourth planned task with its own checkpoint. */
    fourthTask?: boolean;
    /** Run-17 shape (#398): database.evidence pins an earlier browser report
     * revision than the one the browser-acceptance gate proves. */
    splitBrowserEvidence?: boolean;
    /** #449 retry shape: prd/plan artifacts were created under an earlier
     * run and reused. When 'run-0', that sibling run exists on the project. */
    lineageArtifactRunId?: string;
  } = {},
) {
  const harness = makeHarness({}, undefined, { validationCampaign: campaign });
  await seedRun(harness);
  const now = harness.clock.now().toISOString();
  const run = await harness.runs.get('run-1');
  if (!run) throw new Error('run-1 was not seeded');
  if (options.lineageArtifactRunId === 'run-0') {
    await harness.runs.create({
      id: 'run-0',
      projectId: 'project-1',
      workflowId: harness.workflow.id,
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
    });
  }
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
  await seedAgentAttempt(harness, now, {
    stepRunId: 'step-1',
    attemptId: 'attempt-1',
    stepId: 'implement.persistent-storage',
    checkpoint: 'checkpoint-1',
    usage: { providerReportedCostUsd: 0.1 },
  });
  for (const [taskIndex, taskId] of [
    ['2', 'create-list-api'],
    ['3', 'visible-todo-flow'],
    ...(options.fourthTask ? ([['4', 'public-middleware']] as const) : []),
  ] as const) {
    await seedAgentAttempt(harness, now, {
      stepRunId: `step-${taskIndex}`,
      attemptId: `attempt-${taskIndex}`,
      stepId: `implement.${taskId}`,
      checkpoint: `checkpoint-${taskId}`,
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
        steps: options.browserPlanSteps ?? [
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
              steps: options.browserReportSteps
                ? options.browserReportSteps.map((step) => ({
                    stepId: step.id,
                    title: step.title,
                    status: step.status,
                    durationMs: 1,
                    ...(step.error ? { error: step.error } : {}),
                    observations: [],
                  }))
                : [
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
                  modules: [
                    { id: 'crud:todos', acceptanceChannel: 'browser-visible' as const },
                    ...(options.fourthTask
                      ? [{ id: 'auth', acceptanceChannel: 'deterministic-only' as const }]
                      : []),
                  ],
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
                    ...(options.fourthTask
                      ? [
                          {
                            id: 'public-middleware',
                            title: 'Exclude public routes from authentication middleware',
                            dependsOn: [],
                            deliverables: ['public route middleware exclusion'],
                            acceptanceCheck: 'Unauthenticated requests reach public routes.',
                            acceptanceMode: 'deterministic-only' as const,
                            module: 'auth',
                          },
                        ]
                      : []),
                  ],
                },
                decisions: [],
                assumptions: [],
                risks: [],
                nextActions: [],
              }
            : { approved: true };
    // #449 retry shape: prd and the planner-produced plan.current were created
    // under the original run; everything else was produced by the retry run.
    const isLineageName = name === 'prd' || name === 'plan.current';
    const artifactRunId =
      options.lineageArtifactRunId && isLineageName
        ? options.lineageArtifactRunId
        : name === 'prd'
          ? undefined
          : 'run-1';
    const artifact = await harness.artifacts.put({
      projectId: 'project-1',
      name,
      content,
      createdBy: 'validation-test',
      ...(artifactRunId ? { runId: artifactRunId } : {}),
      ...(name === 'implementation.report' || name === 'browser-verification.report'
        ? { stepRunId: 'step-1', attemptId: 'attempt-1' }
        : {}),
      ...(options.lineageArtifactRunId === 'run-0' && name === 'plan.current'
        ? { stepRunId: 'step-0', attemptId: 'attempt-0' }
        : {}),
    });
    const proof: ValidationEvidenceReference = {
      runId: artifact.metadata.runId ?? 'run-1',
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
  if (options.lineageArtifactRunId === 'run-0') {
    const planReference = proofs['plan-approved']?.artifact;
    if (!planReference) throw new Error('missing lineage plan artifact');
    await harness.stepRuns.create({
      id: 'step-0',
      runId: 'run-0',
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
      id: 'attempt-0',
      runId: 'run-0',
      stepRunId: 'step-0',
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
      context: {
        projectId: 'project-1',
        workflowId: harness.workflow.id,
        nodeId: 'plan',
        stepId: 'plan',
      },
      inputArtifacts: [],
      outputArtifacts: [planReference],
    });
  }
  const browserRev1 = proofs['browser-acceptance']?.artifact;
  if (options.splitBrowserEvidence) {
    if (!browserRev1) throw new Error('missing first browser evidence revision');
    const rev1 = await harness.artifacts.getRevision(
      'project-1',
      'browser-verification.report',
      browserRev1.revision,
    );
    if (!rev1) throw new Error('missing first browser evidence artifact');
    const rev2 = await harness.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      content: {
        ...(rev1.content as Record<string, unknown>),
        summary: 'Standalone browser verification passed.',
      },
      createdBy: 'validation-test',
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
    });
    const proof: ValidationEvidenceReference = {
      runId: 'run-1',
      stepRunId: 'step-1',
      attemptId: 'attempt-1',
      artifact: {
        name: rev2.metadata.name,
        revision: rev2.metadata.revision,
        sha256: rev2.metadata.sha256,
      },
    };
    proofs['browser-acceptance'] = proof;
    proofs['preview-healthy'] = proof;
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
      browserArtifact: options.splitBrowserEvidence
        ? browserRev1
        : proofs['browser-acceptance']?.artifact,
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
          optionalScripts: ['db:start', 'db:reset', 'smoke'],
          blocksOnFailure: true,
        },
      ],
    });
    const harness = makeHarness({}, undefined, {
      workflow,
      validationCampaign: campaign,
      secretStore: new FakeSecretStore({
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
      }),
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
    // The gate redirects database reads to the long-lived runtime environment,
    // where the scaffold seed never ran — db:start-dependent scripts like the
    // scaffold smoke are sandbox-only and must not run here (#448).
    expect(harness.verifierInputs[0]?.optionalScripts ?? []).not.toContain('smoke');
    expect(harness.verifierInputs[0]?.optionalScripts ?? []).not.toContain('db:start');
    // The check must query the long-lived runtime database, not the fresh
    // stack db:start boots inside the workspace (#397 runs 8-9).
    expect(harness.verifierInputs[0]?.environment).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
    });
    expect(harness.artifacts.named('database.evidence')).toHaveLength(1);
  });

  it('does not accept caller labels without persisted gate proofs', async () => {
    const { evidence } = await setup();

    await expect(evidence.publish('run-1', request('accepted'))).rejects.toThrow(
      'persisted runtime evidence',
    );
  });

  it('accepts an approved report with an advisory failure and a single reload proof (#453)', async () => {
    const { evidence, proofs } = await setup({
      browserPlanSteps: CYCLE17_PLAN_STEPS,
      browserReportSteps: CYCLE17_REPORT_STEPS,
    });
    const result = await evidence.publish('run-1', request('accepted', proofs));
    expect(result.bundle.outcome).toBe('accepted');
  });

  it('accepts a four-task run whose database evidence pins an earlier browser revision (#398)', async () => {
    const { evidence, proofs } = await setup({
      fourthTask: true,
      splitBrowserEvidence: true,
    });
    const result = await evidence.publish('run-1', request('accepted', proofs));
    expect(result.bundle.outcome).toBe('accepted');
  });

  it('publishes evidence for a retried run that reuses prd/plan from the original run (#449)', async () => {
    const { evidence, proofs } = await setup({ lineageArtifactRunId: 'run-0' });

    const result = await evidence.publish('run-1', request('accepted', proofs));

    expect(result.bundle.outcome).toBe('accepted');
  });

  it('rejects an artifact whose recorded origin is not a run of this project (#449)', async () => {
    const { evidence, proofs } = await setup({ lineageArtifactRunId: 'ghost-run' });

    await expect(evidence.publish('run-1', request('accepted', proofs))).rejects.toThrow(
      /belongs to another run|does not match run/,
    );
  });

  it('keeps attempt counters for step ids containing sensitive words (#589)', async () => {
    const { harness, evidence, proofs } = await setup();
    const now = harness.clock.now().toISOString();
    const sensitiveSteps = [
      'T-auth-setup',
      'T-token-refresh',
      'T-session-store',
      'T-secret-rotation',
    ];
    for (const [index, taskId] of sensitiveSteps.entries()) {
      await seedAgentAttempt(harness, now, {
        stepRunId: `step-sensitive-${index}`,
        attemptId: `attempt-sensitive-${index}`,
        stepId: `implement.${taskId}`,
        nodeId: 'task-execution',
      });
    }

    const first = await evidence.publish('run-1', request('accepted', proofs));
    const second = await evidence.publish('run-1', request('accepted', proofs));

    // The key the gate actually produced, verbatim from the #589 trace.
    expect(first.bundle.usage.attemptsByStep['task-execution/implement.T-auth-setup/1']).toBe(1);
    for (const taskId of sensitiveSteps) {
      expect(first.bundle.usage.attemptsByStep[`task-execution/implement.${taskId}/1`]).toBe(1);
    }
    expect(second.artifact.metadata.revision).toBe(first.artifact.metadata.revision);
    expect(harness.artifacts.named('validation-evidence-real-todo-v1')).toHaveLength(1);
    const readback = ValidationEvidenceBundleSchema.parse(
      harness.artifacts.named('validation-evidence-real-todo-v1')[0]?.content,
    );
    expect(readback.usage.attemptsByStep).toEqual(first.bundle.usage.attemptsByStep);
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

  it('never bundles a concurrent sibling run output as automatic evidence (#449)', async () => {
    const { harness, evidence } = await setup({ withPreflight: false });
    const now = harness.clock.now().toISOString();
    await harness.runs.create({
      id: 'run-9',
      projectId: 'project-1',
      workflowId: harness.workflow.id,
      status: 'running',
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    const foreign = await harness.artifacts.put({
      projectId: 'project-1',
      name: 'implementation.report',
      content: { schemaVersion: '1', status: 'completed', summary: 'other run', data: {} },
      createdBy: 'validation-test',
      runId: 'run-9',
    });

    const result = await evidence.publishFromRun('run-1');

    const implementation = result?.bundle.gates.find(
      (gate) => gate.id === 'implementation-generated',
    );
    const bundled = implementation?.references.find((reference) => reference.artifact);
    expect(bundled?.artifact?.revision).not.toBe(foreign.metadata.revision);
    expect(bundled?.runId).not.toBe('run-9');
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

  it('classifies a run failed by BrowserInfrastructureError as environment, not product (#526, #528)', async () => {
    const { harness, evidence } = await setup();
    const run = await harness.runs.get('run-1');
    if (!run) throw new Error('run-1 was not seeded');
    await harness.runs.update(
      {
        ...run,
        status: 'failed',
        error: {
          // The class name is the only discriminator that survives the run
          // boundary (BrowserInfrastructureError carries no `code`) — see
          // packages/orchestrator/src/workflow-orchestrator.ts `runError`.
          name: 'BrowserInfrastructureError',
          message:
            'browser verification never reached the app: Preview at http://127.0.0.1:59999 is unreachable: connect ECONNREFUSED',
        },
        updatedAt: harness.clock.now().toISOString(),
      },
      run.version,
    );

    const result = await evidence.publish('run-1', request('environment-blocked'));

    expect(result.bundle.outcome).toBe('environment-blocked');
  });

  it.each([
    ["the generated app's dev server", 'PreviewStartError', 'PREVIEW_START_FAILED'],
    ["the generated app's dependencies", 'PreviewInstallError', 'PREVIEW_INSTALL_FAILED'],
  ])(
    'classifies a product-origin preview failure as product, not environment: %s (#667)',
    async (_case, name, code) => {
      const { harness, evidence } = await setup();
      const run = await harness.runs.get('run-1');
      if (!run) throw new Error('run-1 was not seeded');
      await harness.runs.update(
        {
          ...run,
          status: 'failed',
          // A defect in the generated app. Classifying it 'environment'
          // excuses it instead of repairing it — #659 pointing the other way.
          error: { name, code, message: 'Dev server exited immediately twice.' },
          updatedAt: harness.clock.now().toISOString(),
        },
        run.version,
      );

      const result = await evidence.publish('run-1', request('product-failed'));

      expect(result.bundle.outcome).toBe('product-failed');
    },
  );

  it('keeps an unavailable preview classified as environment (#659, #667)', async () => {
    const { harness, evidence } = await setup();
    const run = await harness.runs.get('run-1');
    if (!run) throw new Error('run-1 was not seeded');
    await harness.runs.update(
      {
        ...run,
        status: 'failed',
        // The runner marked this environment-origin. Dropping 'preview' from
        // the classifier must not take this with it: 'infrastructure' is in
        // both halves of the identity and is what carries the origin.
        error: {
          name: PREVIEW_INFRASTRUCTURE_ERROR_NAME,
          code: PREVIEW_INFRASTRUCTURE_ERROR_CODE,
          message:
            'docker create failed: failed to connect to the docker API at unix:///var/run/docker.sock',
        },
        updatedAt: harness.clock.now().toISOString(),
      },
      run.version,
    );

    const result = await evidence.publish('run-1', request('environment-blocked'));

    expect(result.bundle.outcome).toBe('environment-blocked');
  });

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
