import { describe, expect, it, vi } from 'vitest';
import type { ModelDefinition, WorkflowDefinition, WorkflowRun } from '@agent-foundry/contracts';
import {
  agentStepTargets,
  executionEvidence,
  modelOverrideRequest,
  retryMode,
  retryRequest,
} from './model-overrides';
import { createModelOverride } from './api';

const models = [
  { id: 'codex-fast', provider: 'codex', model: 'gpt-5.1-codex' },
  { id: 'claude-deep', provider: 'claude', model: 'claude-opus-4-1' },
] as ModelDefinition[];

const audit = {
  modelId: 'codex-fast',
  actorKind: 'user' as const,
  actorId: 'operator-1',
  reason: 'Incident mitigation',
  estimatedImpact: 'Higher token cost',
};

describe('model override request helpers', () => {
  it('posts a typed override request for the selected run', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          override: {
            id: 'override-1',
            runId: 'run-1',
            sequence: 1,
            modelId: 'codex-fast',
            createdAt: '2026-07-16T00:00:00.000Z',
            ...modelOverrideRequest(models, { kind: 'run' }, audit),
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );

    await createModelOverride('run-1', modelOverrideRequest(models, { kind: 'run' }, audit));

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/runs/run-1/model-overrides',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(modelOverrideRequest(models, { kind: 'run' }, audit)),
      }),
    );
    fetchMock.mockRestore();
  });

  it('shapes run and step pins from a selected catalog tuple', () => {
    expect(modelOverrideRequest(models, { kind: 'run' }, audit)).toEqual({
      scope: { kind: 'run' },
      provider: 'codex',
      model: 'gpt-5.1-codex',
      actor: { kind: 'user', id: 'operator-1' },
      reason: 'Incident mitigation',
      estimatedImpact: 'Higher token cost',
    });
    expect(
      modelOverrideRequest(models, { kind: 'step', nodeId: 'quality', stepId: 'repair' }, audit),
    ).toMatchObject({ scope: { kind: 'step', nodeId: 'quality', stepId: 'repair' } });
  });

  it.each(['user', 'system', 'worker', 'provider'] as const)(
    'retains the %s actor kind',
    (actorKind) => {
      expect(
        modelOverrideRequest(models, { kind: 'run' }, { ...audit, actorKind }).actor.kind,
      ).toBe(actorKind);
    },
  );

  it('rejects blank audit fields and unresolved catalog models', () => {
    expect(() => modelOverrideRequest(models, { kind: 'run' }, { ...audit, reason: ' ' })).toThrow(
      'reason',
    );
    expect(() =>
      modelOverrideRequest(models, { kind: 'run' }, { ...audit, modelId: 'unknown' }),
    ).toThrow('catalog');
    expect(() =>
      modelOverrideRequest([{ ...models[0]!, model: '' }], { kind: 'run' }, audit),
    ).toThrow('resolved model');
  });

  it('rejects disabled catalog models for persistent and retry pins', () => {
    const disabled = [{ ...models[0]!, enabled: false }];

    expect(() => modelOverrideRequest(disabled, { kind: 'run' }, audit)).toThrow('disabled');
    expect(() => retryRequest('preserve', disabled, audit)).toThrow('disabled');
  });

  it('omits an unselected retry pin and shapes a selected retry pin', () => {
    expect(retryRequest('preserve', models)).toEqual({ mode: 'preserve' });
    expect(retryRequest('invalidate', models, audit)).toEqual({
      mode: 'invalidate',
      override: {
        provider: 'codex',
        model: 'gpt-5.1-codex',
        actor: { kind: 'user', id: 'operator-1' },
        reason: 'Incident mitigation',
        estimatedImpact: 'Higher token cost',
      },
    });
  });

  it('defaults keyboard retry submission to the preserving mode', () => {
    expect(retryMode(undefined)).toBe('preserve');
    expect(retryMode('unexpected')).toBe('preserve');
    expect(retryMode('invalidate')).toBe('invalidate');
  });
});

describe('agent step discovery', () => {
  it('includes top-level and quality-loop agent members only', () => {
    const workflow = {
      nodes: [
        { id: 'plan', type: 'agent', title: 'Plan' },
        { id: 'verify', type: 'verify', title: 'Verify' },
        {
          id: 'quality',
          type: 'quality-loop',
          title: 'Quality',
          setup: { id: 'setup', type: 'agent', title: 'Setup' },
          check: { id: 'check', type: 'agent', title: 'Check' },
          repair: { id: 'repair', type: 'agent', title: 'Repair' },
        },
      ],
    } as WorkflowDefinition;

    expect(agentStepTargets(workflow)).toEqual([
      { nodeId: 'plan', stepId: 'plan', label: 'Plan' },
      { nodeId: 'quality', stepId: 'setup', label: 'Quality / Setup' },
      { nodeId: 'quality', stepId: 'check', label: 'Quality / Check' },
      { nodeId: 'quality', stepId: 'repair', label: 'Quality / Repair' },
    ]);
  });
});

describe('execution evidence', () => {
  it('formats active time, repairs, ceiling evidence, error, and exact draft branch', () => {
    const run = {
      error: { code: 'EMERGENCY_CEILING' },
      execution: {
        activeElapsedMs: 3_661_000,
        activeSince: '2026-07-16T00:00:00.000Z',
        consecutiveRepairs: 10,
        ceiling: {
          reason: 'consecutive-repairs',
          reachedAt: '2026-07-16T01:01:02.000Z',
          draftBranch: 'draft/run-16',
        },
      },
    } as WorkflowRun;

    expect(executionEvidence(run, Date.parse('2026-07-16T00:00:01.000Z'))).toEqual({
      activeElapsed: '1h 1m 2s',
      consecutiveRepairs: '10',
      ceiling: `consecutive-repairs · ${new Date('2026-07-16T01:01:02.000Z').toLocaleString(
        'pt-BR',
      )}`,
      errorCode: 'EMERGENCY_CEILING',
      draftBranch: 'draft/run-16',
    });
  });
});
