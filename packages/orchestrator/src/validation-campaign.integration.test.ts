import { describe, expect, it, vi } from 'vitest';
import {
  ModelDefinitionSchema,
  ValidationCampaignPreviewSchema,
  WorkflowDefinitionSchema,
  createValidationCampaignExecution,
} from '@agent-foundry/contracts';
import { ValidationCampaignLimitError, type Clock } from '@agent-foundry/domain';
import { liveStepRun, makeHarness, makeStores, seedRun } from './testing/harness.js';
import { summarizeValidationUsage } from './validation-budget.js';

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
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      models: premiumModels,
      validationCampaign: campaign,
    });
    await seedRun(harness);
    await recordFailedAttempt(harness, 'plan', 'plan');
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

  it('rejects a premium promotion when it is not more expensive than the failed candidate', async () => {
    const stores = makeStores();
    const cheaperPremiumModels = premiumModels.map((model) =>
      model.id === 'campaign-model-2' ? { ...model, pricing: premiumModels[0]!.pricing } : model,
    );
    const harness = makeHarness({}, stores, {
      models: cheaperPremiumModels,
      validationCampaign: campaign,
    });
    await seedRun(harness);
    await recordFailedAttempt(harness, 'plan', 'plan');
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
      const stores = makeStores();
      const harness = makeHarness({}, stores, {
        models: promotionModels,
        validationCampaign: campaign,
        usage: { inputTokens: 100, outputTokens: 100 },
      });
      await seedRun(harness);
      await recordFailedAttempt(harness, 'plan', 'plan');
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
