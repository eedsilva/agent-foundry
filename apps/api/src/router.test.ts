import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
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
