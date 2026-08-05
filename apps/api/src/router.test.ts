import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { TaskProfileSchema, type ValidationPreflightReport } from '@agent-foundry/contracts';
import { buildApp } from './app.js';

describe('router dashboard + experiments API', () => {
  let runtime: Runtime;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dataDir: string;
  let workflowsDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'router-api-data-'));
    workflowsDir = await mkdtemp(join(tmpdir(), 'router-api-wf-'));
    runtime = await createRuntime({
      ...process.env,
      DATA_DIR: dataDir,
      WORKFLOWS_DIR: workflowsDir,
      EXECUTOR_MODE: 'mock',
    } as NodeJS.ProcessEnv);
    app = await buildApp(runtime);
  });

  afterEach(async () => {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workflowsDir, { recursive: true, force: true });
  });

  it('returns empty facets and null KPIs with no decisions', async () => {
    const response = await app.inject({ method: 'GET', url: '/router/dashboard' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.facets.modelIds).toEqual([]);
    expect(body.kpis.sampleSize).toBe(0);
    expect(body.kpis.firstPassRate).toBeNull();
  });

  it('requires an explicitly selected campaign before preflight', async () => {
    const response = await app.inject({ method: 'POST', url: '/validation/campaign/preflight' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'VALIDATION_CAMPAIGN_NOT_READY' });
  });

  it('creates, lists, and updates an experiment', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/experiments',
      payload: {
        hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
        variants: [
          { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
          { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
        ],
        population: { taskKinds: ['implementation'], targetSampleSize: 30 },
        stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.8, minSamples: 20 },
      },
    });
    expect(create.statusCode).toBe(201);
    const { experiment } = create.json();
    expect(experiment.status).toBe('draft');

    const list = await app.inject({ method: 'GET', url: '/experiments' });
    expect(list.json().experiments).toHaveLength(1);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/experiments/${experiment.id}`,
      payload: { status: 'concluded', conclusion: 'Opus wins.' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().experiment.status).toBe('concluded');
  });

  it('exports decisions with no project/run/node identifiers', async () => {
    const response = await app.inject({ method: 'GET', url: '/router/export' });
    expect(response.statusCode).toBe(200);
    const { rows } = response.json();
    for (const row of rows) {
      expect(row).not.toHaveProperty('projectId');
      expect(row).not.toHaveProperty('runId');
      expect(row).not.toHaveProperty('nodeId');
    }
  });

  it('returns the selected validation campaign route preview with the source revision', async () => {
    const selectedRuntime = await createRuntime(
      {
        ...process.env,
        DATA_DIR: dataDir,
        WORKFLOWS_DIR: workflowsDir,
        EXECUTOR_MODE: 'real',
        VALIDATION_CAMPAIGN: 'real-todo-v1',
        CODEX_DEFAULT_MODEL: 'gpt-5.6-luna',
      } as NodeJS.ProcessEnv,
      undefined,
      undefined,
      { generatedProjectRuntime: null },
    );
    const selectedApp = await buildApp(selectedRuntime);

    const response = await selectedApp.inject({ method: 'GET', url: '/validation/campaign' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      availableCampaigns: ['real-todo-v1'],
      selectedCampaign: 'real-todo-v1',
      preview: {
        id: 'real-todo-v1',
        sourceRevision: expect.stringMatching(/^[0-9a-f]{40}$/),
        allowedModels: [
          { id: 'opencode-ollama' },
          { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
          { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
        ],
      },
    });
    expect((await selectedRuntime.router.catalog()).map((model) => model.id)).toContain(
      'claude-opus',
    );
    const normalPlanningRoute = await selectedRuntime.router.route(
      TaskProfileSchema.parse({
        role: 'planner',
        taskKind: 'planning',
        complexity: 1,
        risk: 1,
        estimatedContextTokens: 100,
        estimatedOutputTokens: 100,
        mutatesWorkspace: false,
        priorities: { quality: 0.7, speed: 0.1, cost: 0.05, reliability: 0.15 },
        preferredTags: [],
      }),
      undefined,
      { routing: { source: 'web-app-v1', executors: ['claude', 'glm', 'codex', 'agy'] } },
    );
    expect(normalPlanningRoute.selected.model.id).toBe('claude-opus');
    expect(normalPlanningRoute.routingTable).toMatchObject({
      source: 'web-app-v1',
      taskKind: 'planning',
    });

    const report: ValidationPreflightReport = {
      schemaVersion: '1',
      campaignId: 'real-todo-v1',
      sourceRevision: 'a'.repeat(40),
      dataDirectory: dataDir,
      executorMode: 'real',
      environmentId: 'validation-preflight-test',
      startedAt: '2026-08-03T12:00:00.000Z',
      completedAt: '2026-08-03T12:00:01.000Z',
      status: 'environment-blocked',
      checks: [
        {
          boundary: 'docker',
          status: 'failed',
          durationMs: 1,
          errorCode: 'PREFLIGHT_FAILED',
          message: 'docker prerequisite failed.',
        },
      ],
      generatedProjectCreated: false,
    };
    const runnableApp = await buildApp({
      ...selectedRuntime,
      runValidationPreflight: async () => report,
    });
    const preflight = await runnableApp.inject({
      method: 'POST',
      url: '/validation/campaign/preflight',
    });
    expect(preflight.statusCode).toBe(200);
    // The route redacts on the way out: the operator's data directory is not
    // part of the response contract.
    expect(preflight.json()).toEqual({ ...report, dataDirectory: '[REDACTED]' });
    await runnableApp.close();

    await selectedApp.close();
  });

  it('rate-limits /router/regression-gate at 30 requests/min/IP', async () => {
    const responses = [];
    for (let i = 0; i < 31; i++) {
      responses.push(
        await app.inject({ method: 'POST', url: '/router/regression-gate', payload: {} }),
      );
    }
    expect(responses.slice(0, 30).every((response) => response.statusCode !== 429)).toBe(true);
    expect(responses[30]?.statusCode).toBe(429);
  });
});
