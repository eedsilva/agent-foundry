import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { TRACER_NAME } from '@agent-foundry/domain';

/**
 * Registers the onRequest/onResponse hook pair that wraps every request in a
 * `foundry.request` span. Call only when telemetry is actually configured
 * (see app.ts, gated on `runtime.config.otelExporterOtlpEndpoint`): with no
 * OTLP endpoint the spans this creates are never exported anyway (withSpan
 * and friends are already @opentelemetry/api no-ops), but registering these
 * hooks still costs a span create+end and a WeakMap set/delete on every
 * request — never registering them is the true zero-cost path. The pino
 * `mixin: () => currentTraceIds()` wired in app.ts degrades on its own (no
 * active span means no ids) and needs no gating of its own.
 *
 * ponytail: SSE routes (identified by their `/stream` suffix) hijack the
 * reply (see streamSse in app.ts), and Fastify never runs onResponse for a
 * hijacked reply — a span opened here for those routes would never end. The
 * simplest correct cut is to skip request spans on hijacked routes entirely;
 * add explicit end-at-headers-sent instrumentation in streamSse if SSE
 * request-level tracing becomes a requirement.
 */
export function registerRequestTracing(app: FastifyInstance): void {
  const requestSpans = new WeakMap<FastifyRequest, Span>();
  app.addHook('onRequest', (request, _reply, done) => {
    if (request.routeOptions.url?.endsWith('/stream')) {
      done();
      return;
    }
    const span = trace.getTracer(TRACER_NAME).startSpan('foundry.request', {
      attributes: {
        'http.method': request.method,
        'http.route': request.routeOptions.url ?? request.url,
      },
    });
    requestSpans.set(request, span);
    // onResponse only fires on raw finish/error, never on a client-aborted
    // connection — this fallback ends+removes the span so it isn't leaked
    // (never exported) when the client disconnects early. Deleted from the
    // map before ending so a normal completion racing this can't double-end.
    request.raw.on('close', () => {
      const tracked = requestSpans.get(request);
      if (!tracked) return;
      requestSpans.delete(request);
      tracked.end();
    });
    context.with(trace.setSpan(context.active(), span), done);
  });
  app.addHook('onResponse', async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    requestSpans.delete(request);
    span.setAttribute('http.status_code', reply.statusCode);
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  });
}
