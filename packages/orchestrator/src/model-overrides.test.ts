import { describe, expect, it } from 'vitest';
import { completeRun, liveStepRun, makeHarness, seedRun } from './testing/harness.js';

const audit = {
  actor: { kind: 'user' as const, id: 'ed' },
  reason: 'Pin the verified model',
  estimatedImpact: 'More reliable output',
};

describe('audited model override resolution', () => {
  it('rejects a step scope that does not identify an agent step in the run workflow', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    await expect(
      harness.service.createModelOverride('run-1', {
        scope: { kind: 'step', nodeId: 'typo', stepId: 'implement' },
        modelId: 'model-2',
        provider: 'codex',
        model: 'alt-model',
        ...audit,
      }),
    ).rejects.toThrow(/does not identify an agent step/);
    expect(await harness.modelOverrides.list('run-1')).toEqual([]);
  });

  it('rejects a selected catalog identity whose provider/model tuple differs', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    await expect(
      harness.service.createModelOverride('run-1', {
        scope: { kind: 'run' },
        modelId: 'model-2',
        provider: 'codex',
        model: 'test-model',
        ...audit,
      }),
    ).rejects.toThrow(/catalog tuple changed/);
    expect(await harness.modelOverrides.list('run-1')).toEqual([]);
  });

  it('uses the newest step pin before the run pin', async () => {
    const harness = makeHarness();
    await seedRun(harness);
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'run' },
      modelId: 'model-1',
      provider: 'codex',
      model: 'test-model',
      ...audit,
    });
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'implement', stepId: 'implement' },
      modelId: 'model-1',
      provider: 'codex',
      model: 'test-model',
      ...audit,
    });
    const latest = await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'implement', stepId: 'implement' },
      modelId: 'model-2',
      provider: 'codex',
      model: 'alt-model',
      ...audit,
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const plan = liveStepRun(harness, 'plan');
    const implement = liveStepRun(harness, 'implement');
    const planAttempt = (await harness.stepAttempts.list('run-1', plan.id))[0];
    const implementAttempt = (await harness.stepAttempts.list('run-1', implement.id))[0];
    expect(planAttempt?.modelId).toBe('model-1');
    expect(planAttempt?.routeDecision?.override?.source).toBe('run');
    expect(implementAttempt?.modelId).toBe('model-2');
    expect(implementAttempt?.routeDecision?.override).toMatchObject({
      source: 'step',
      overrideId: latest.id,
      ...audit,
    });
    expect(implementAttempt?.routeDecision?.fallbacks).toEqual([]);
  });

  it('uses an audited retry pin before a matching step pin', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');
    await harness.service.createModelOverride('run-1', {
      scope: { kind: 'step', nodeId: 'implement', stepId: 'implement' },
      modelId: 'model-2',
      provider: 'codex',
      model: 'alt-model',
      ...audit,
    });
    const retryRun = await harness.service.retryStep('run-1', implement.id, {
      mode: 'preserve',
      override: {
        modelId: 'model-1',
        provider: 'codex',
        model: 'test-model',
        actor: { kind: 'user', id: 'token=raw-actor-secret' },
        reason: 'Authorization: Bearer raw-reason-secret',
        estimatedImpact: 'Cookie: session=raw-impact-secret; csrf=also-secret',
      },
    });
    expect((await harness.runs.get('run-1'))?.retry?.override).toMatchObject({
      actor: { kind: 'user', id: 'token=[REDACTED]' },
      reason: 'Authorization: [REDACTED]',
      estimatedImpact: 'Cookie: [REDACTED]',
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const retried = liveStepRun(harness, 'implement');
    const attempt = (await harness.stepAttempts.list('run-1', retried.id))[0];
    expect(attempt?.modelId).toBe('model-1');
    expect(attempt?.routeDecision?.override).toMatchObject({
      source: 'retry',
      actor: { kind: 'user', id: 'token=[REDACTED]' },
      reason: 'Authorization: [REDACTED]',
      estimatedImpact: 'Cookie: [REDACTED]',
      createdAt: retryRun.retry?.requestedAt,
    });
    expect(attempt?.routeDecision?.fallbacks).toEqual([]);
  });

  it('keeps a legacy retry pin visible with explicit compatibility provenance', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');
    const queued = await harness.service.retryStep('run-1', implement.id, {
      mode: 'preserve',
      override: { modelId: 'model-2', provider: 'codex', model: 'alt-model', ...audit },
    });
    await harness.runs.update(
      {
        ...queued,
        retry: {
          ...queued.retry!,
          override: { modelId: 'model-2', provider: 'codex', model: 'alt-model' },
        },
      },
      queued.version,
    );

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const retried = liveStepRun(harness, 'implement');
    const attempt = (await harness.stepAttempts.list('run-1', retried.id))[0];
    expect(attempt?.routeDecision?.override).toMatchObject({
      source: 'retry',
      actor: { kind: 'system', id: 'legacy-retry' },
      reason: 'Legacy retry override without a recorded reason',
      estimatedImpact: 'Not recorded in legacy retry directive',
    });
  });
});
