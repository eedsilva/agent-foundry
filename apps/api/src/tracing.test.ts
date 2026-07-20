import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance } from 'fastify';
import { createRuntime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

async function startApi(): Promise<{ app: FastifyInstance; baseUrl: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-tracing-'));
  dirs.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'tracing-worker',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { app, baseUrl };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('apps/api foundry.request span', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    provider.register();
  });

  afterEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('creates a foundry.request span for an ordinary route with method/route/status', async () => {
    const { baseUrl } = await startApi();

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const span = exporter.getFinishedSpans().find((item) => item.name === 'foundry.request');
    expect(span).toBeDefined();
    expect(span?.attributes).toMatchObject({
      'http.method': 'GET',
      'http.route': '/health',
      'http.status_code': 200,
    });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  // ponytail: SSE routes hijack the reply and Fastify never fires onResponse
  // for a hijacked reply, so app.ts intentionally skips request spans for
  // them (see the ponytail note in app.ts). This proves that cut: an SSE
  // request must not leave behind an un-ended foundry.request span.
  it('does not create a foundry.request span for a hijacked SSE route', async () => {
    const { baseUrl } = await startApi();

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/projects/does-not-exist/events/stream`, {
      signal: controller.signal,
    }).catch(() => undefined);
    controller.abort();

    // 404s before streaming (unknown project), but still via the hijack-skipping route.
    expect(response?.status).toBe(404);
    expect(exporter.getFinishedSpans().some((item) => item.name === 'foundry.request')).toBe(false);
  });
});
