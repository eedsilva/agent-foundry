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

async function startApi(options?: {
  loggerStream?: { write(message: string): void };
  registerRoutes?: (app: FastifyInstance) => void;
}): Promise<{ app: FastifyInstance; baseUrl: string }> {
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
  const app = await buildApp(runtime, options);
  apps.push(app);
  options?.registerRoutes?.(app);
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

  // Regression: pino's `mixin: () => currentTraceIds()` (wired in buildApp)
  // is how request logs get correlated to a trace. Prove it end to end — a
  // log line written while the foundry.request span is active carries that
  // exact span's traceId/spanId, not just "some" id.
  it('carries the active foundry.request span traceId/spanId on a request-scoped log line', async () => {
    const lines: string[] = [];
    const { baseUrl } = await startApi({
      loggerStream: { write: (message) => lines.push(message) },
      registerRoutes: (app) => {
        app.get('/__mixin_probe__', async (request) => {
          request.log.info('mixin probe line');
          return { ok: true };
        });
      },
    });

    const response = await fetch(`${baseUrl}/__mixin_probe__`);
    expect(response.status).toBe(200);

    const span = exporter
      .getFinishedSpans()
      .find((item) => item.attributes['http.route'] === '/__mixin_probe__');
    expect(span).toBeDefined();
    const { traceId, spanId } = span!.spanContext();

    const probeLine = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.msg === 'mixin probe line');
    expect(probeLine).toBeDefined();
    expect(probeLine?.traceId).toBe(traceId);
    expect(probeLine?.spanId).toBe(spanId);
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

  // Regression: onResponse only fires on raw finish/error, never on a client
  // disconnect, so a request whose client aborts mid-flight used to leave its
  // span open forever (never exported, and never removed from the tracking
  // map). Streams a request body that never completes so the route's JSON
  // body parser blocks and the handler never runs — a deterministic
  // "in-flight" request with no race against the response completing
  // normally — then aborts the client connection.
  it('ends and exports the foundry.request span when the client aborts before a response is sent', async () => {
    const { baseUrl } = await startApi();

    await postWithStalledBodyThenAbort(baseUrl);
    const spans = exporter.getFinishedSpans().filter((item) => item.name === 'foundry.request');
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      'http.method': 'POST',
      'http.route': '/projects',
    });

    // Repeating the abort proves the tracking map's entry was actually
    // removed (not just left to be garbage-collected): a second aborted
    // request produces exactly one more finished span, not zero (leaked)
    // and not a double-end error.
    await postWithStalledBodyThenAbort(baseUrl);
    const spansAfterSecondAbort = exporter
      .getFinishedSpans()
      .filter((item) => item.name === 'foundry.request');
    expect(spansAfterSecondAbort).toHaveLength(2);
  });
});

// Sends a POST whose body stream stalls mid-request (so the JSON body parser
// blocks and the route handler never runs), then aborts the client
// connection. Node's fetch type doesn't yet declare `duplex`, required by the
// underlying undici implementation for streamed request bodies.
async function postWithStalledBodyThenAbort(baseUrl: string): Promise<void> {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.enqueue(new TextEncoder().encode('{"name":"x"'));
      // Never enqueue the rest or close — the server's body parser waits forever.
    },
  });

  const pending = fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    signal: controller.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' }).catch(() => undefined);

  // Give the server a beat to receive headers (span created in onRequest)
  // and start waiting on the body; well under the 100ms budget.
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await pending;
  // Let the server's raw 'close' handler run.
  await new Promise((resolve) => setTimeout(resolve, 50));
}
