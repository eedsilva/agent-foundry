import { afterEach, describe, expect, it } from 'vitest';
import {
  ROOT_CONTEXT,
  SamplingDecision,
  SpanKind,
  SpanStatusCode,
  type Attributes,
} from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { currentTraceIds, withSpan } from '@agent-foundry/domain';
import {
  KeepErrorsSampler,
  RedactingSpanExporter,
  startTelemetry,
  TailSpanProcessor,
} from './telemetry.js';

describe('startTelemetry with no endpoint configured', () => {
  it('registers nothing — withSpan and trace-id lookup stay no-ops', async () => {
    const handle = startTelemetry({
      serviceName: 'test-service',
      endpoint: undefined,
      sampleRatio: 1,
      slowRunThresholdMs: 60_000,
    });

    const result = await withSpan('foundry.test', {}, async () => {
      expect(currentTraceIds()).toEqual({});
      return 'ran';
    });

    expect(result).toBe('ran');
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });
});

function fakeReadableSpan(attributes: Attributes): ReadableSpan {
  return {
    name: 'foundry.test',
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      traceFlags: 1,
    }),
    startTime: [0, 0],
    endTime: [0, 0],
    status: { code: 0 },
    attributes,
    links: [],
    events: [],
    duration: [0, 0],
    ended: true,
    resource: {} as ReadableSpan['resource'],
    instrumentationScope: { name: 'agent-foundry' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function fakeDelegateExporter(): SpanExporter & { exported: ReadableSpan[][] } {
  const exported: ReadableSpan[][] = [];
  return {
    exported,
    export(spans, resultCallback: Parameters<SpanExporter['export']>[1]) {
      exported.push(spans);
      resultCallback({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
  };
}

describe('RedactingSpanExporter', () => {
  it('rewrites a bearer/JWT-shaped string attribute to contain [REDACTED]', () => {
    const delegate = fakeDelegateExporter();
    const exporter = new RedactingSpanExporter(delegate, 60_000);
    const span = fakeReadableSpan({
      'foundry.attempt.id': 'attempt-1',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y',
    });

    exporter.export([span], () => undefined);

    expect(delegate.exported).toHaveLength(1);
    expect(span.attributes.authorization).toContain('[REDACTED]');
    expect(span.attributes.authorization).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(span.attributes['foundry.attempt.id']).toBe('attempt-1');
  });

  it('stamps foundry.slow=true when foundry.run.duration_ms exceeds the threshold', () => {
    const delegate = fakeDelegateExporter();
    const exporter = new RedactingSpanExporter(delegate, 1_000);
    const slowSpan = fakeReadableSpan({ 'foundry.run.duration_ms': 5_000 });
    const fastSpan = fakeReadableSpan({ 'foundry.run.duration_ms': 500 });

    exporter.export([slowSpan, fastSpan], () => undefined);

    expect(slowSpan.attributes['foundry.slow']).toBe(true);
    expect(fastSpan.attributes['foundry.slow']).toBeUndefined();
  });

  // Regression: span.recordException(error) produces an `exception` event
  // carrying exception.message/exception.stacktrace, and a failed span's
  // status carries a developer-facing message — neither lives in
  // span.attributes, so the attribute-only redaction pass used to leave a
  // secret in both places on export.
  it('redacts the status message and every event attribute, not just span attributes', () => {
    const delegate = fakeDelegateExporter();
    const exporter = new RedactingSpanExporter(delegate, 60_000);
    const secret = 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y secret';
    const span = fakeReadableSpan({ 'foundry.attempt.id': 'attempt-1' });
    span.status.code = SpanStatusCode.ERROR;
    span.status.message = `call failed: ${secret}`;
    span.events.push({
      time: [0, 0],
      name: 'exception',
      attributes: {
        'exception.type': 'Error',
        'exception.message': secret,
        'exception.stacktrace': `Error: ${secret}\n    at fn (file.js:1:1)`,
      },
    });

    exporter.export([span], () => undefined);

    expect(span.status.message).toContain('[REDACTED]');
    expect(span.status.message).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    const [event] = span.events;
    expect(event?.attributes?.['exception.message']).toContain('[REDACTED]');
    expect(event?.attributes?.['exception.message']).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(event?.attributes?.['exception.stacktrace']).toContain('[REDACTED]');
    expect(event?.attributes?.['exception.stacktrace']).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    // Not secret-shaped — redactString is a no-op on it, but it proves event
    // names go through the same pass rather than being skipped outright.
    expect(event?.name).toBe('exception');
  });
});

describe('KeepErrorsSampler', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';

  it('samples a foundry.force_sample span at ratio 0', () => {
    const sampler = new KeepErrorsSampler(0);
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      traceId,
      'foundry.attempt',
      SpanKind.INTERNAL,
      { 'foundry.force_sample': true },
      [],
    );
    expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  // Not NOT_RECORD: a NOT_RECORD span is non-recording, so a catch block that
  // reacts *after* the span started (setStatus/setAttribute/recordException)
  // would be a silent no-op — the exact bug this sampler exists to avoid.
  // RECORD keeps the span's data alive through onEnd, where
  // TailSpanProcessor makes the real (export-time) keep/drop call.
  it('records (but does not head-sample) a plain span at ratio 0', () => {
    const sampler = new KeepErrorsSampler(0);
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      traceId,
      'foundry.attempt',
      SpanKind.INTERNAL,
      {},
      [],
    );
    expect(result.decision).toBe(SamplingDecision.RECORD);
  });
});

describe('TailSpanProcessor export-time keep', () => {
  let provider: NodeTracerProvider | undefined;

  afterEach(async () => {
    await provider?.shutdown();
    provider = undefined;
  });

  // End-to-end through a real NodeTracerProvider (not a hand-built
  // SamplingResult) — proves the sampler + processor combination actually
  // does what workflow-orchestrator's catch blocks rely on: a span that
  // starts before its outcome is known can still be flagged reactively and
  // survive ratio-0 sampling.
  it('exports an ERROR-status span at ratio 0; a plain OK span stays dropped', () => {
    const delegate = fakeDelegateExporter();
    const redacting = new RedactingSpanExporter(delegate, 60_000);
    provider = new NodeTracerProvider({
      sampler: new KeepErrorsSampler(0),
      spanProcessors: [new TailSpanProcessor(new BatchSpanProcessor(redacting), redacting, 60_000)],
    });
    const tracer = provider.getTracer('test');

    const failing = tracer.startSpan('foundry.attempt');
    failing.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
    failing.end();

    const ok = tracer.startSpan('foundry.attempt');
    ok.end();

    const exported = delegate.exported.flat();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('exports a span reactively flagged foundry.force_sample after it started, at ratio 0', () => {
    const delegate = fakeDelegateExporter();
    const redacting = new RedactingSpanExporter(delegate, 60_000);
    provider = new NodeTracerProvider({
      sampler: new KeepErrorsSampler(0),
      spanProcessors: [new TailSpanProcessor(new BatchSpanProcessor(redacting), redacting, 60_000)],
    });
    const tracer = provider.getTracer('test');

    // No foundry.force_sample at creation time — set only in the "catch
    // block", after the sampling decision already happened.
    const span = tracer.startSpan('foundry.attempt');
    span.setAttribute('foundry.force_sample', true);
    span.end();

    const exported = delegate.exported.flat();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.attributes['foundry.force_sample']).toBe(true);
  });

  it('exports a span whose foundry.run.duration_ms exceeds the threshold, at ratio 0', () => {
    const delegate = fakeDelegateExporter();
    const redacting = new RedactingSpanExporter(delegate, 1_000);
    provider = new NodeTracerProvider({
      sampler: new KeepErrorsSampler(0),
      spanProcessors: [new TailSpanProcessor(new BatchSpanProcessor(redacting), redacting, 1_000)],
    });
    const tracer = provider.getTracer('test');

    const span = tracer.startSpan('foundry.run');
    span.setAttribute('foundry.run.duration_ms', 5_000);
    span.end();

    const exported = delegate.exported.flat();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.attributes['foundry.slow']).toBe(true);
  });

  // At ratio 1 the span is head-sampled (SAMPLED trace flag set), so it goes
  // out through the normal BatchSpanProcessor path. onEnd's alreadySampled
  // guard must skip the tail direct-export path in that case — otherwise an
  // ERROR span would be exported twice (once batched, once direct).
  it('exports an already-sampled ERROR span exactly once, via the batch path', async () => {
    const delegate = fakeDelegateExporter();
    const redacting = new RedactingSpanExporter(delegate, 60_000);
    provider = new NodeTracerProvider({
      sampler: new KeepErrorsSampler(1),
      spanProcessors: [new TailSpanProcessor(new BatchSpanProcessor(redacting), redacting, 60_000)],
    });
    const tracer = provider.getTracer('test');

    const failing = tracer.startSpan('foundry.attempt');
    failing.setStatus({ code: SpanStatusCode.ERROR, message: 'boom' });
    failing.end();

    await provider.forceFlush();

    expect(delegate.exported).toHaveLength(1);
    const exported = delegate.exported.flat();
    expect(exported).toHaveLength(1);
    expect(exported[0]?.status.code).toBe(SpanStatusCode.ERROR);
  });
});
