import { describe, expect, it, vi } from 'vitest';
import type { Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

function buildFakeRuntime(options?: {
  database?: () => Promise<void>;
  workerRunning?: boolean;
  persistenceMode?: 'file' | 'postgres';
  runWorkerInline?: boolean;
}): Runtime {
  return {
    config: {
      webOrigin: 'http://localhost:3000',
      executorMode: 'mock',
      persistenceMode: options?.persistenceMode ?? 'postgres',
      runWorkerInline: options?.runWorkerInline ?? true,
    },
    worker: { isRunning: options?.workerRunning ?? true },
    checkReadiness: options?.database ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as Runtime;
}

describe('readiness', () => {
  it('keeps /health as liveness when readiness dependencies are down', async () => {
    const app = await buildApp(
      buildFakeRuntime({
        database: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:54399')),
        workerRunning: false,
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, executorMode: 'mock' });
    await app.close();
  });

  it('reports a down database as unavailable without exposing its connection error', async () => {
    const app = await buildApp(
      buildFakeRuntime({
        database: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:54399')),
      }),
    );

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, database: 'unavailable', worker: 'ready' });
    expect(response.body).not.toContain('127.0.0.1:54399');
    await app.close();
  });

  it('reports a stopped inline worker as unavailable', async () => {
    const app = await buildApp(buildFakeRuntime({ workerRunning: false }));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, database: 'ready', worker: 'unavailable' });
    await app.close();
  });

  it('does not require disabled persistence or an external worker', async () => {
    const app = await buildApp(
      buildFakeRuntime({ persistenceMode: 'file', runWorkerInline: false, workerRunning: false }),
    );

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      database: 'not_required',
      worker: 'not_required',
    });
    await app.close();
  });
});
