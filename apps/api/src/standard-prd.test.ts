import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import type { AgentExecutionRequest } from '@agent-foundry/contracts';
import { buildApp } from './app.js';
import { VALID_STANDARD_PRD } from './test-support/standard-prd-fixture.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createProjectDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-standard-prd-project-'));
  dirs.push(path);
  return path;
}

async function startApi(): Promise<{
  app: FastifyInstance;
  runtime: Runtime;
  executionRequests: AgentExecutionRequest[];
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-standard-prd-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'standard-prd-worker',
  });
  const executionRequests: AgentExecutionRequest[] = [];
  const executor = runtime.executors.get('mock');
  const execute = executor.execute.bind(executor);
  executor.execute = (request, ...args) => {
    executionRequests.push(request);
    return execute(request, ...args);
  };
  const app = await buildApp(runtime);
  apps.push(app);
  return { app, runtime, executionRequests };
}

describe('PRD Standard 1 intake gate (#643)', () => {
  it('accepts a conforming PRD, persists its canonical markdown, and returns its identity', async () => {
    const { app, runtime } = await startApi();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        name: 'Task list',
        prd: VALID_STANDARD_PRD,
        projectDirectory: await createProjectDirectory(),
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    const body = response.json() as { project: { id: string }; identity: string };
    expect(body.identity).toMatch(/^[a-f0-9]{64}$/);

    const artifact = await runtime.artifacts.getLatest(body.project.id, 'prd');
    expect(typeof artifact?.content).toBe('string');
    expect(
      createHash('sha256')
        .update(artifact!.content as string)
        .digest('hex'),
    ).toBe(body.identity);
  });

  it('rejects a non-Standard PRD with the first issue before queue or executor activity', async () => {
    const { app, runtime, executionRequests } = await startApi();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        name: 'Task list',
        prd: 'x'.repeat(200),
        projectDirectory: await createProjectDirectory(),
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'StandardPrdRejectedError',
      code: 'missing-or-duplicate-field',
      path: 'title',
      message: 'PRD title is required.',
    });
    expect(await runtime.projectService.list(1)).toEqual([]);
    expect(await runtime.worker.runOnce()).toBe(false);
    expect(executionRequests).toHaveLength(0);

    // Non-vacuity pair: the same meter observes the first model call after a
    // conforming request reaches the queue.
    const accepted = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        name: 'Task list',
        prd: VALID_STANDARD_PRD,
        projectDirectory: await createProjectDirectory(),
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(await runtime.worker.runOnce()).toBe(true);
    expect(executionRequests).toHaveLength(1);
  });

  it('rejects every PRD over the 50,000-character Standard 1 ceiling before trimming', async () => {
    const { app } = await startApi();

    const response = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: {
        name: 'Task list',
        prd: VALID_STANDARD_PRD.padEnd(50_001, ' '),
        projectDirectory: await createProjectDirectory(),
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'StandardPrdRejectedError',
      code: 'max-length',
      path: 'document',
    });
  });
});
