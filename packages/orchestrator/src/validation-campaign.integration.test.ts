import { describe, expect, it, vi } from 'vitest';
import {
  ModelDefinitionSchema,
  ValidationCampaignPreviewSchema,
  WorkflowDefinitionSchema,
  createValidationCampaignExecution,
  type AgentArtifact,
  type PreviewSession,
  type PreviewWorkspaceRef,
  type StepRun,
  type StepAttempt,
} from '@agent-foundry/contracts';
import { ValidationCampaignLimitError, type Clock } from '@agent-foundry/domain';
import {
  liveStepRun,
  makeHarness,
  makeStores,
  seedRun,
  timeoutError,
  type StepBehavior,
  type Stores,
} from './testing/harness.js';
import { summarizeValidationUsage } from './validation-budget.js';
import { ValidationEvidenceService } from './validation-evidence.js';

const capabilities = {
  planning: 1,
  architecture: 1,
  coding: 1,
  review: 1,
  repair: 1,
  structuredOutput: 1,
  speed: 1,
  costEfficiency: 1,
  reliability: 1,
};

const models = [
  ModelDefinitionSchema.parse({
    id: 'campaign-model-1',
    provider: 'codex',
    model: 'campaign-model-1',
    billingMode: 'subscription',
    maxContextTokens: 200_000,
    capabilities,
  }),
  ModelDefinitionSchema.parse({
    id: 'campaign-model-2',
    provider: 'codex',
    model: 'campaign-model-2',
    billingMode: 'subscription',
    maxContextTokens: 200_000,
    capabilities,
  }),
];

const premiumModels = models.map((model, index) =>
  ModelDefinitionSchema.parse({
    ...model,
    billingMode: 'metered',
    pricing: {
      inputUsdPerMillionTokens: index === 0 ? 1 : 10,
      outputUsdPerMillionTokens: index === 0 ? 1 : 10,
    },
  }),
);
const subscriptionPremiumModels = premiumModels.map((model) =>
  ModelDefinitionSchema.parse({ ...model, billingMode: 'subscription' }),
);

const campaign = ValidationCampaignPreviewSchema.parse({
  schemaVersion: '1',
  id: 'real-todo-v1',
  name: 'Test campaign',
  sourceRevision: 'a'.repeat(40),
  allowedModels: [
    { id: 'campaign-model-1', provider: 'codex', model: 'campaign-model-1' },
    { id: 'campaign-model-3', provider: 'codex', model: 'campaign-model-3' },
    { id: 'campaign-model-4', provider: 'codex', model: 'campaign-model-4' },
  ],
  routes: [
    {
      taskKind: 'planning',
      selected: { id: models[0]!.id, provider: models[0]!.provider, model: models[0]!.model },
      fallbacks: [],
    },
    {
      taskKind: 'implementation',
      selected: { id: models[0]!.id, provider: models[0]!.provider, model: models[0]!.model },
      fallbacks: [],
    },
    {
      taskKind: 'code-review',
      selected: { id: models[0]!.id, provider: models[0]!.provider, model: models[0]!.model },
      fallbacks: [],
    },
  ],
  limits: {
    attemptsPerAgentStep: 1,
    targetedRepairs: 1,
    activeTimeMinutes: 1,
    meteredCostUsd: 2,
  },
});

const validationFailureWorkflow = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'validation-failure-v1',
  name: 'Validation failure fixture',
  description: 'A single planning step with a task-graph output contract.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan the work.',
      outputArtifact: 'plan',
      outputContract: 'task-graph',
      maxAttempts: 1,
    },
  ],
});

class TestClock implements Clock {
  private current = Date.parse('2026-08-03T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

async function seedCampaignRun(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await seedRun(harness);
  const run = await harness.runs.get('run-1');
  if (!run) throw new Error('run-1 was not seeded');
  await harness.runs.update(
    {
      ...run,
      execution: {
        activeElapsedMs: 0,
        consecutiveRepairs: 0,
        campaign: createValidationCampaignExecution(campaign),
      },
    },
    run.version,
  );
}

describe('validation campaign run enforcement', () => {
  it('stops before a metered dispatch whose catalog estimate would exceed the limit', async () => {
    const stores = makeStores();
    const expensiveModels = models.map((model) =>
      ModelDefinitionSchema.parse({
        ...model,
        billingMode: 'metered',
        pricing: { inputUsdPerMillionTokens: 1_000_000, outputUsdPerMillionTokens: 1_000_000 },
      }),
    );
    const harness = makeHarness({}, stores, {
      models: expensiveModels,
      validationCampaign: campaign,
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'metered-cost limit',
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('stops at the exact metered ceiling before a subscription fallback can run', async () => {
    const stores = makeStores();
    const meteredModel = ModelDefinitionSchema.parse({
      ...models[0],
      billingMode: 'metered',
      pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
    });
    const fallbackCampaign = ValidationCampaignPreviewSchema.parse({
      ...campaign,
      allowedModels: [
        { id: meteredModel.id, provider: meteredModel.provider, model: meteredModel.model },
        { id: models[1]!.id, provider: models[1]!.provider, model: models[1]!.model },
        campaign.allowedModels[2]!,
      ],
      routes: campaign.routes.map((route) =>
        route.taskKind === 'planning'
          ? {
              ...route,
              selected: {
                id: meteredModel.id,
                provider: meteredModel.provider,
                model: meteredModel.model,
              },
              fallbacks: [
                { id: models[1]!.id, provider: models[1]!.provider, model: models[1]!.model },
              ],
            }
          : route,
      ),
    });
    const harness = makeHarness({}, stores, {
      fallback: true,
      models: [meteredModel, models[1]!],
      validationCampaign: fallbackCampaign,
    });
    await seedRun(harness);
    const now = harness.clock.now().toISOString();
    await harness.stepRuns.create({
      id: 'previous-step',
      runId: 'run-1',
      nodeId: 'previous',
      stepId: 'previous',
      stepType: 'agent',
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    await harness.stepAttempts.create({
      id: 'previous-attempt',
      runId: 'run-1',
      stepRunId: 'previous-step',
      sequence: 1,
      executorKind: 'agent',
      provider: 'codex',
      model: meteredModel.model,
      modelId: meteredModel.id,
      status: 'succeeded',
      version: 1,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      usage: { providerReportedCostUsd: 2 },
      context: {
        projectId: 'project-1',
        workflowId: harness.workflow.id,
        nodeId: 'previous',
        stepId: 'previous',
      },
      inputArtifacts: [],
      outputArtifacts: [],
    });
    const run = await harness.runs.get('run-1');
    if (!run) throw new Error('run-1 was not seeded');
    await harness.runs.update(
      {
        ...run,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(fallbackCampaign),
        },
      },
      run.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'metered-cost limit',
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('stops before an unknown metered dispatch without guessing its cost', async () => {
    const stores = makeStores();
    const unknownModels = models.map((model) =>
      ModelDefinitionSchema.parse({ ...model, billingMode: 'metered', pricing: undefined }),
    );
    const harness = makeHarness({}, stores, {
      models: unknownModels,
      validationCampaign: campaign,
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'unknown-cost limit',
    );

    const summary = summarizeValidationUsage(harness.stepAttempts.all(), unknownModels);
    expect(summary.unknownMeteredAttempts).toBe(0);
    expect(summary.meteredCostUsd).toBe(0);
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('stops before a subscription dispatch when provider quota is exhausted', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      executorHealth: {
        provider: 'codex',
        available: true,
        version: 'test',
        message: 'quota exhausted',
        rateLimit: { limit: 1, remaining: 0 },
      },
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'subscription-quota limit',
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('stops before a subscription dispatch when quota metadata is unavailable', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      executorHealth: {
        provider: 'codex',
        available: true,
        version: 'test',
        message: 'quota metadata unavailable',
      },
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'subscription-quota limit',
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('rejects a provider response that exceeds subscription quota before promotion', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      usage: { quotaUnits: 2 },
      executorHealth: {
        provider: 'codex',
        available: true,
        version: 'test',
        message: 'quota exceeded after dispatch',
        rateLimit: { limit: 10, remaining: 1 },
      },
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'subscription-quota limit',
    );
    expect(harness.executor.requests).toHaveLength(1);
    expect(harness.stepAttempts.all()[0]?.status).toBe('failed');
  });

  it('rejects a provider-reported executed model outside the campaign identity', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      executedModel: 'unapproved-premium-model',
    });
    await seedCampaignRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'does not match',
    );
    expect(harness.executor.requests).toHaveLength(1);
    expect(harness.stepAttempts.all()[0]?.status).toBe('failed');
  });

  it('retains provider usage across a cancellation after the provider response', async () => {
    const stores = makeStores();
    const controller = new AbortController();
    const harness = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      usage: { providerReportedCostUsd: 1, quotaUnits: 2 },
    });
    await seedCampaignRun(harness);
    let aborted = false;
    stores.stepAttempts.onBeforeUpdate = (attempt) => {
      if (!aborted && attempt.usage) {
        aborted = true;
        controller.abort();
      }
    };

    await harness.orchestrator.runProject('project-1', undefined, 'run-1', controller.signal);

    const attempt = harness.stepAttempts.all()[0];
    expect(attempt?.status).toBe('cancelled');
    expect(attempt?.usage).toMatchObject({ providerReportedCostUsd: 1, quotaUnits: 2 });
  });

  it('enforces persisted attempt accounting after an orchestrator restart', async () => {
    const stores = makeStores();
    const controller = new AbortController();
    const first = makeHarness({}, stores, {
      models,
      validationCampaign: campaign,
      usage: { quotaUnits: 3 },
    });
    await seedCampaignRun(first);
    let aborted = false;
    stores.stepAttempts.onBeforeUpdate = (attempt) => {
      if (!aborted && attempt.usage) {
        aborted = true;
        controller.abort();
      }
    };
    await first.orchestrator.runProject('project-1', undefined, 'run-1', controller.signal);
    const cancelled = await stores.runs.get('run-1');
    if (!cancelled) throw new Error('run-1 was not persisted after cancellation');
    const queued = { ...cancelled, status: 'queued' as const };
    delete queued.error;
    delete queued.startedAt;
    delete queued.completedAt;
    await stores.runs.update(queued, cancelled.version);

    const restarted = makeHarness({}, stores, { models, validationCampaign: campaign });
    await expect(
      restarted.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow('attempts limit');

    expect(summarizeValidationUsage(stores.stepAttempts.all(), models).subscriptionQuotaUnits).toBe(
      3,
    );
    expect(restarted.executor.requests).toHaveLength(0);
  });

  it('persists provider usage before output validation and enforces it after restart', async () => {
    const stores = makeStores();
    const meteredModels = models.map((model) =>
      ModelDefinitionSchema.parse({
        ...model,
        billingMode: 'metered',
        pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
      }),
    );
    const first = makeHarness({}, stores, {
      workflow: validationFailureWorkflow,
      models: meteredModels,
      validationCampaign: campaign,
      usage: { providerReportedCostUsd: 1 },
    });
    await seedCampaignRun(first);

    await expect(first.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'task graph',
    );
    const failed = await stores.runs.get('run-1');
    if (!failed) throw new Error('run-1 was not persisted after validation failure');
    const queued = { ...failed, status: 'queued' as const };
    delete queued.error;
    delete queued.startedAt;
    delete queued.completedAt;
    await stores.runs.update(queued, failed.version);

    const restarted = makeHarness({}, stores, {
      workflow: validationFailureWorkflow,
      models: meteredModels,
      validationCampaign: campaign,
    });
    await expect(
      restarted.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow('attempts limit');

    const summary = summarizeValidationUsage(stores.stepAttempts.all(), meteredModels);
    expect(summary.providerReportedCostUsd).toBe(1);
    expect(restarted.executor.requests).toHaveLength(0);
  });

  it('allows one targeted preserve retry without refunding the campaign attempt bound', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, { models, validationCampaign: campaign });
    await seedCampaignRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const review = liveStepRun(harness, 'review');
    await harness.service.retryStep('run-1', review.id, { mode: 'preserve' });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('review')).toBe(2);
    expect((await harness.runs.get('run-1'))?.execution?.campaign?.targetedRepairs).toBe(1);
  });

  it('counts a failed dispatch before fallback so automatic fallback cannot bypass attempts', async () => {
    const stores = makeStores();
    const fallbackCampaign = ValidationCampaignPreviewSchema.parse({
      ...campaign,
      allowedModels: [
        { id: models[0]!.id, provider: models[0]!.provider, model: models[0]!.model },
        { id: models[1]!.id, provider: models[1]!.provider, model: models[1]!.model },
        campaign.allowedModels[2]!,
      ],
      routes: campaign.routes.map((route) =>
        route.taskKind === 'planning'
          ? {
              ...route,
              fallbacks: [
                { id: models[1]!.id, provider: models[1]!.provider, model: models[1]!.model },
              ],
            }
          : route,
      ),
    });
    const harness = makeHarness(
      { plan: { kind: 'fail-once', error: () => new Error('planned failure') } },
      stores,
      { fallback: true, models, validationCampaign: fallbackCampaign },
    );
    await seedRun(harness);
    const run = await stores.runs.get('run-1');
    expect(run).toBeDefined();
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(fallbackCampaign),
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'attempts limit',
    );
    expect(harness.executor.started('plan')).toBe(1);
    expect((await stores.runs.get('run-1'))?.error).toMatchObject({
      name: 'ValidationCampaignLimitError',
      code: 'VALIDATION_CAMPAIGN_LIMIT',
    });
  });

  it('checks campaign active time before any model dispatch and preserves cancellation precedence', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, { models, validationCampaign: campaign });
    await seedRun(harness);
    const run = await stores.runs.get('run-1');
    expect(run).toBeDefined();
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: {
            ...createValidationCampaignExecution(campaign),
            activeElapsedMs: 60_000,
          },
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      ValidationCampaignLimitError,
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('aborts an in-flight dispatch when campaign active time expires', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({ plan: { kind: 'hang-until-abort' } }, stores, {
      models,
      validationCampaign: campaign,
      usage: { quotaUnits: 1 },
      cancelledWithUsage: true,
    });
    await seedCampaignRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => expect(harness.executor.requests).toHaveLength(1));
    clock.advance(60_000);

    await expect(running).rejects.toThrow('active-time limit');
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(harness.stepAttempts.all()[0]?.status).toBe('failed');
    expect(harness.stepAttempts.all()[0]?.usage).toMatchObject({ quotaUnits: 1 });
  });

  it('lets cancellation win over an already exhausted campaign budget', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, { models, validationCampaign: campaign });
    await seedRun(harness);
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...run!,
        status: 'cancel_requested',
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: {
            ...createValidationCampaignExecution(campaign),
            activeElapsedMs: 60_000,
          },
        },
      },
      run!.version,
    );

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect((await stores.runs.get('run-1'))?.status).toBe('cancelled');
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('rejects a premium promotion without the failed-step reproducer audit', async () => {
    const stores = makeStores();
    const harness = makeHarness({}, stores, { models, validationCampaign: campaign });
    await seedRun(harness);
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'run' },
      modelId: 'campaign-model-2',
      provider: 'codex',
      model: 'campaign-model-2',
      actor: { kind: 'user', id: 'operator' },
      reason: 'Try the stronger model',
      estimatedImpact: 'More spend',
    });
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(campaign),
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /failed step, same minimal reproducer, cheaper candidate/i,
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('rejects a premium promotion when the reproducer does not match the failed attempt', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({}, stores, {
      models: premiumModels,
      validationCampaign: campaign,
    });
    await seedRun(harness);
    await recordFailedAttempt(harness, 'plan', 'plan');
    clock.advance(1);
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'plan', stepId: 'plan' },
      modelId: 'campaign-model-2',
      provider: 'codex',
      model: 'campaign-model-2',
      actor: { kind: 'user', id: 'operator' },
      failedStep: 'plan/plan',
      minimalReproducer: 'a different failure',
      reason: 'The restricted model failed the same reproducer',
      estimatedImpact: 'One premium planning dispatch',
    });
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(campaign),
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /same minimal reproducer/i,
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('rejects a premium promotion whose audit predates the failed attempt', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const harness = makeHarness({}, stores, {
      models: premiumModels,
      validationCampaign: campaign,
    });
    await seedRun(harness);
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'plan', stepId: 'plan' },
      modelId: 'campaign-model-2',
      provider: 'codex',
      model: 'campaign-model-2',
      actor: { kind: 'user', id: 'operator' },
      failedStep: 'plan/plan',
      minimalReproducer: 'plan output violates the task graph contract',
      reason: 'The restricted model failed the same reproducer',
      estimatedImpact: 'One premium planning dispatch',
    });
    clock.advance(1);
    await recordFailedAttempt(harness, 'plan', 'plan');
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(campaign),
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /after a recorded failed attempt/i,
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('rejects a premium promotion when it is not more expensive than the failed candidate', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const cheaperPremiumModels = premiumModels.map((model) =>
      model.id === 'campaign-model-2' ? { ...model, pricing: premiumModels[0]!.pricing } : model,
    );
    const harness = makeHarness({}, stores, {
      models: cheaperPremiumModels,
      validationCampaign: campaign,
    });
    await seedRun(harness);
    await recordFailedAttempt(harness, 'plan', 'plan');
    clock.advance(1);
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'plan', stepId: 'plan' },
      modelId: 'campaign-model-2',
      provider: 'codex',
      model: 'campaign-model-2',
      actor: { kind: 'user', id: 'operator' },
      failedStep: 'plan/plan',
      minimalReproducer: 'plan output violates the task graph contract',
      reason: 'The restricted model failed the same reproducer',
      estimatedImpact: 'One premium planning dispatch',
    });
    const run = await stores.runs.get('run-1');
    await stores.runs.update(
      {
        ...run!,
        execution: {
          activeElapsedMs: 0,
          consecutiveRepairs: 0,
          campaign: createValidationCampaignExecution(campaign),
        },
      },
      run!.version,
    );

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /cheaper candidate/i,
    );
    expect(harness.executor.requests).toHaveLength(0);
  });

  it.each([
    ['metered', premiumModels],
    ['subscription', subscriptionPremiumModels],
  ] as const)(
    'allows a known-priced %s premium promotion with matching audit evidence',
    async (_billingMode, promotionModels) => {
      const clock = new TestClock();
      const stores = makeStores(clock);
      const harness = makeHarness({}, stores, {
        models: promotionModels,
        validationCampaign: campaign,
        usage: { inputTokens: 100, outputTokens: 100 },
      });
      await seedRun(harness);
      await recordFailedAttempt(harness, 'plan', 'plan');
      clock.advance(1);
      await harness.service.createModelOverride('run-1', {
        scope: { kind: 'step', nodeId: 'plan', stepId: 'plan' },
        modelId: 'campaign-model-2',
        provider: 'codex',
        model: 'campaign-model-2',
        actor: { kind: 'user', id: 'operator' },
        failedStep: 'plan/plan',
        minimalReproducer: 'plan output violates the task graph contract',
        reason: 'The restricted model failed the same reproducer',
        estimatedImpact: 'One premium planning dispatch',
      });
      const run = await stores.runs.get('run-1');
      await stores.runs.update(
        {
          ...run!,
          execution: {
            activeElapsedMs: 0,
            consecutiveRepairs: 0,
            campaign: createValidationCampaignExecution(campaign),
          },
        },
        run!.version,
      );

      await harness.orchestrator.runProject('project-1', undefined, 'run-1');
      expect(harness.executor.requests[0]?.model).toBe('campaign-model-2');
      expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    },
  );
});

/**
 * A campaign that walks a two-task graph, so a downstream task can fail after a
 * predecessor task has already completed — the shape #396 has to prove.
 */
const taskRetryWorkflow = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'task-retry-v1',
  name: 'Task retry fixture',
  description: 'Plans a task graph and executes each task in dependency order.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan the tasks.',
      outputArtifact: 'plan.current',
      outputContract: 'task-graph',
    },
    {
      id: 'task-execution',
      type: 'for-each-task',
      title: 'Implement tasks',
      taskGraphArtifact: 'plan.current',
      implement: {
        id: 'implement',
        type: 'agent',
        role: 'developer',
        taskKind: 'implementation',
        title: 'Implement task',
        instructions: 'Implement the task.',
        inputArtifacts: ['plan.current'],
        outputArtifact: 'implementation.report',
        mutatesWorkspace: true,
        maxAttempts: 1,
      },
      verify: {
        id: 'verify-task',
        type: 'verify',
        title: 'Verify task',
        outputArtifact: 'verification.report',
        scripts: [],
      },
      repair: {
        id: 'repair-task',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair task',
        instructions: 'Repair the task.',
        inputArtifacts: ['verification.report'],
        outputArtifact: 'verification.fix',
        mutatesWorkspace: true,
      },
    },
  ],
});

const taskRetryPlan: AgentArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Planned two dependent tasks.',
  data: {
    schemaVersion: '1',
    goal: 'Ship the TODO slice',
    tasks: [
      {
        id: 'T1',
        title: 'Persist todos',
        dependsOn: [],
        deliverables: ['src/db.ts'],
        acceptanceCheck: 'Rows persist',
        acceptanceMode: 'deterministic-only',
      },
      {
        id: 'T2',
        title: 'List todos',
        dependsOn: ['T1'],
        deliverables: ['src/list.ts'],
        acceptanceCheck: 'The list returns the stored rows',
        acceptanceMode: 'deterministic-only',
      },
    ],
  },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};

/**
 * Wires a campaign run over a task graph. A real ValidationEvidenceService is
 * used rather than a stub so the terminal bundle is the one the operator reads.
 */
async function seedTaskCampaignRun(
  behaviors: Record<string, StepBehavior> = {},
  options: { existingStores?: Stores; models?: typeof models } = {},
) {
  // Passing existingStores rebuilds the orchestrator over a run that is already
  // seeded and part-executed — the seam a restart or a drifted catalog needs.
  const stores = options.existingStores ?? makeStores();
  const catalog = options.models ?? models;
  const now = stores.clock.now().toISOString();
  const evidence = new ValidationEvidenceService(
    stores.runs,
    stores.stepRuns,
    stores.stepAttempts,
    stores.artifacts,
    catalog,
    stores.events,
    async () => ({
      schemaVersion: '1' as const,
      campaignId: campaign.id,
      sourceRevision: campaign.sourceRevision,
      dataDirectory: '/tmp/validation-preserve-retry-test',
      executorMode: 'real' as const,
      environmentId: 'validation-preserve-retry-test',
      startedAt: now,
      completedAt: now,
      status: 'passed' as const,
      checks: [{ boundary: 'source-revision' as const, status: 'passed' as const, durationMs: 1 }],
      generatedProjectCreated: false as const,
    }),
  );
  const previewStart = vi.fn(
    async (input: { workspaceRef: PreviewWorkspaceRef; runId?: string }) => ({
      session: {
        id: 'preview-1',
        workspaceRef: input.workspaceRef,
        status: 'running',
        url: 'http://127.0.0.1/preview/preview-1/?token=t',
        version: 1,
        health: { state: 'healthy', checkedAt: now, consecutiveFailures: 0 },
        ttl: { seconds: 1_800 },
        restartCount: 0,
        createdAt: now,
        updatedAt: now,
        ...(input.runId ? { runId: input.runId } : {}),
      } satisfies PreviewSession,
      url: 'http://127.0.0.1/preview/preview-1/?token=t',
    }),
  );
  const harness = makeHarness(behaviors, stores, {
    workflow: taskRetryWorkflow,
    models: catalog,
    validationCampaign: campaign,
    validationEvidence: evidence,
    previews: { start: previewStart, activeForProject: async () => undefined },
    agentOutput: (request) => (request.stepId === 'plan' ? taskRetryPlan : undefined),
  });
  if (!options.existingStores) await seedCampaignRun(harness);
  return { stores, harness, evidence, previewStart };
}

/** The predecessor work a preserve retry must leave alone, snapshot and compare. */
const PRESERVED_STEP_IDS = ['plan', 'implement.T1', 'verify-task.T1'] as const;

/**
 * Reads the named steps with their attempts through the public run detail —
 * ids, checkpoints, commits and artifact revisions in one comparable value.
 * Asserts the ids matched, so an empty result can never compare equal.
 */
async function stepsByIds(
  harness: ReturnType<typeof makeHarness>,
  stepIds: readonly string[],
): Promise<Array<{ step: StepRun; attempts: StepAttempt[] }>> {
  const detail = await harness.service.getRunDetail('run-1');
  const found = detail.steps.filter((entry) => stepIds.includes(entry.step.stepId));
  expect(found.map((entry) => entry.step.stepId)).toEqual([...stepIds]);
  return found;
}

/** Runs the campaign until the downstream task fails, and returns that failed step run. */
async function arrangeFailedTask(options: { models?: typeof models } = {}) {
  const seeded = await seedTaskCampaignRun(
    { 'implement.T2': { kind: 'fail-once', error: () => timeoutError() } },
    options,
  );
  await expect(
    seeded.harness.orchestrator.runProject('project-1', undefined, 'run-1'),
  ).rejects.toThrow(/Command timed out/);
  return { ...seeded, failed: liveStepRun(seeded.harness, 'implement.T2') };
}

describe('targeted preserve retry (#396)', () => {
  it('recovers the failed task from its checkpoint without touching the completed predecessor', async () => {
    const { harness, previewStart, failed } = await arrangeFailedTask();

    // (1) The predecessor task completed before the deterministic downstream failure.
    expect(harness.events.types()).toContain('task.completed');
    expect(harness.events.types()).toContain('task.failed');
    expect(liveStepRun(harness, 'implement.T1').status).toBe('completed');
    expect(failed.status).toBe('failed');
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');

    // (2) The plan names the failed step and the state preserve mode retains.
    const failedAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === failed.id);
    const plan = await harness.service.retryPlan('run-1', failed.id);
    expect(plan.target.id).toBe(failed.id);
    expect(plan.target.stepId).toBe('implement.T2');
    expect(plan.downstream).toEqual([]);
    expect(plan.artifacts).toEqual([]);
    expect(plan.checkpoint).toBe(failedAttempt?.checkpoint);

    // Retrying the predecessor instead would retain the later task's outputs —
    // the same plan, read for the step whose retry does have downstream work.
    const predecessor = liveStepRun(harness, 'implement.T1');
    const predecessorPlan = await harness.service.retryPlan('run-1', predecessor.id);
    expect(predecessorPlan.downstream.map((step) => step.stepId)).toContain('implement.T2');
    expect(predecessorPlan.artifacts).toContain('verification.report');

    // (4, arrange) Everything the retry must not recreate.
    const before = await stepsByIds(harness, PRESERVED_STEP_IDS);
    expect(before.every((entry) => entry.attempts.length > 0)).toBe(true);
    const implementationRevisions = harness.artifacts.named('implementation.report').length;

    await harness.service.retryStep('run-1', failed.id, { mode: 'preserve' });
    // The previewed checkpoint is the one the directive carries into the replay.
    expect((await harness.runs.get('run-1'))?.retry?.checkpoint).toBe(plan.checkpoint);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // (3) Only the failed target re-executed, from its recorded checkpoint.
    expect(harness.workspaces.rollbacks).toContain(plan.checkpoint);
    expect(harness.executor.started('plan')).toBe(1);
    expect(harness.executor.started('implement.T1')).toBe(1);
    expect(harness.executor.started('implement.T2')).toBe(2);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');

    // (4) Provisioning and the completed predecessor are untouched.
    expect(await stepsByIds(harness, PRESERVED_STEP_IDS)).toEqual(before);
    expect(previewStart).toHaveBeenCalledTimes(1);
    expect(harness.events.types().filter((type) => type === 'project.provisioned')).toHaveLength(1);
    expect(harness.artifacts.named('implementation.report')).toHaveLength(
      implementationRevisions + 1,
    );

    // (5) History is append-only and names the route the new attempt used.
    const invalidated = harness.stepRuns
      .byStepId('run-1', 'implement.T2')
      .find((step) => step.id === failed.id);
    expect(invalidated).toMatchObject({ invalidationReason: 'retry-requested' });
    expect(invalidated?.invalidatedAt).toBeDefined();
    expect(await harness.stepAttempts.get('run-1', failed.id, failedAttempt!.id)).toMatchObject({
      status: 'failed',
      checkpoint: failedAttempt!.checkpoint,
    });
    const retried = liveStepRun(harness, 'implement.T2');
    expect(retried.id).not.toBe(failed.id);
    const retryAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === retried.id);
    expect(retryAttempt?.sequence).toBe(1);
    expect(retryAttempt?.routeDecision?.selected.model.id).toBe('campaign-model-1');
    expect(harness.events.types()).toContain('step.retry_requested');
    expect((await harness.runs.get('run-1'))?.execution?.campaign?.targetedRepairs).toBe(1);
  });

  it('publishes the original failure and the targeted recovery in one bundle', async () => {
    const { harness, evidence, failed } = await arrangeFailedTask();
    expect((await evidence.get('run-1')).bundle.terminalState.status).toBe('failed');

    await harness.service.retryStep('run-1', failed.id, { mode: 'preserve' });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const recovered = liveStepRun(harness, 'implement.T2');

    const { bundle } = await evidence.get('run-1');
    // Both the original failure and its recovery, on their two distinct step runs.
    const taskAttempts = bundle.attempts.filter((attempt) =>
      [failed.id, recovered.id].includes(attempt.reference.stepRunId ?? ''),
    );
    expect(taskAttempts.map((attempt) => attempt.status).sort()).toEqual(['failed', 'succeeded']);
    expect(new Set(taskAttempts.map((attempt) => attempt.reference.attemptId)).size).toBe(2);
    expect(bundle.usage.attemptsByStep['task-execution/implement.T2/1']).toBe(2);
    expect(bundle.terminalState.status).toBe('completed');
    // Not 'accepted': an automatic capture still awaits the operator walkthrough.
    expect(bundle.outcome).toBe('product-failed');
    expect(harness.artifacts.named('validation-evidence-real-todo-v1')).toHaveLength(2);
  });

  it('rejects an invalid preserve retry without mutating the run', async () => {
    const { harness, failed } = await arrangeFailedTask();
    await harness.service.retryStep('run-1', failed.id, { mode: 'preserve' });

    const unchanged = async (retry: () => Promise<unknown>, diagnostic: RegExp): Promise<void> => {
      const run = await harness.runs.get('run-1');
      const stepRuns = await harness.stepRuns.list('run-1');
      const enqueued = harness.enqueued.length;
      const retries = harness.events.types().filter((type) => type === 'step.retry_requested');

      await expect(retry()).rejects.toThrow(diagnostic);

      expect(await harness.runs.get('run-1')).toEqual(run);
      expect(await harness.stepRuns.list('run-1')).toEqual(stepRuns);
      expect(harness.enqueued).toHaveLength(enqueued);
      expect(harness.events.types().filter((type) => type === 'step.retry_requested')).toEqual(
        retries,
      );
    };

    // The retry is already queued for replay: a second one names the run state.
    await unchanged(
      () => harness.service.retryStep('run-1', failed.id, { mode: 'preserve' }),
      /only completed or failed runs support step retry/,
    );

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');

    // The superseded step run stays retryable-looking but is not a valid target.
    await unchanged(
      () => harness.service.retryStep('run-1', failed.id, { mode: 'preserve' }),
      /already invalidated/,
    );
  });

  it('fails the replay with a catalog drift diagnostic instead of restarting the campaign', async () => {
    const { stores, harness, failed } = await arrangeFailedTask();
    await harness.service.retryStep('run-1', failed.id, {
      mode: 'preserve',
      override: {
        modelId: 'campaign-model-1',
        provider: 'codex',
        model: 'campaign-model-1',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Re-run the failed task on the same campaign model',
        estimatedImpact: 'Recovers the failed task without new spend',
      },
    });
    const before = await stepsByIds(harness, PRESERVED_STEP_IDS);
    const attemptsBefore = stores.stepAttempts.all().length;

    // The catalog moves under the persisted pin between the request and the replay.
    const drifted = await seedTaskCampaignRun(
      {},
      {
        existingStores: stores,
        models: models.map((model, index) =>
          index === 0
            ? ModelDefinitionSchema.parse({ ...model, model: 'campaign-model-1-renamed' })
            : model,
        ) as typeof models,
      },
    );

    await expect(
      drifted.harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow(/catalog tuple changed/);

    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    // Rejected before dispatch: no new attempt, so nothing was silently restarted.
    expect(stores.stepAttempts.all()).toHaveLength(attemptsBefore);
    expect(await stepsByIds(drifted.harness, PRESERVED_STEP_IDS)).toEqual(before);
  });

  it('stops a second preserve retry at the campaign attempt limit', async () => {
    const { harness, failed } = await arrangeFailedTask();
    await harness.service.retryStep('run-1', failed.id, { mode: 'preserve' });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const recovered = liveStepRun(harness, 'implement.T2');
    const before = await stepsByIds(harness, PRESERVED_STEP_IDS);
    await harness.service.retryStep('run-1', recovered.id, { mode: 'preserve' });

    const replay = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await expect(replay).rejects.toThrow(ValidationCampaignLimitError);
    // Names which limit stopped it, not just that some ceiling fired.
    await expect(replay).rejects.toThrow(/attempts limit/);
    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect((await harness.runs.get('run-1'))?.error?.code).toBe('VALIDATION_CAMPAIGN_LIMIT');
    expect(harness.executor.started('implement.T2')).toBe(2);
    expect(await stepsByIds(harness, PRESERVED_STEP_IDS)).toEqual(before);
  });
});

async function recordFailedAttempt(
  harness: ReturnType<typeof makeHarness>,
  nodeId: string,
  stepId: string,
): Promise<void> {
  const now = harness.clock.now().toISOString();
  const stepRunId = `failed-${nodeId}-${stepId}`;
  await harness.stepRuns.create({
    id: stepRunId,
    runId: 'run-1',
    nodeId,
    stepId,
    stepType: 'agent',
    status: 'failed',
    version: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });
  await harness.stepAttempts.create({
    id: `failed-attempt-${nodeId}-${stepId}`,
    runId: 'run-1',
    stepRunId,
    sequence: 1,
    executorKind: 'agent',
    provider: 'codex',
    model: models[0]!.model,
    modelId: models[0]!.id,
    status: 'failed',
    version: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    usage: { providerReportedCostUsd: 0 },
    error: {
      name: 'ExecutionError',
      message: 'plan output violates the task graph contract',
    },
    context: {
      projectId: 'project-1',
      workflowId: harness.workflow.id,
      nodeId,
      stepId,
    },
    inputArtifacts: [],
    outputArtifacts: [],
  });
}
