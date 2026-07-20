import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, SamplingDecision, SpanKind, type Attributes } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { currentTraceIds, withSpan } from '@agent-foundry/domain';
import { KeepErrorsSampler, RedactingSpanExporter, startTelemetry } from './telemetry.js';

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

  it('drops a plain span at ratio 0', () => {
    const sampler = new KeepErrorsSampler(0);
    const result = sampler.shouldSample(
      ROOT_CONTEXT,
      traceId,
      'foundry.attempt',
      SpanKind.INTERNAL,
      {},
      [],
    );
    expect(result.decision).toBe(SamplingDecision.NOT_RECORD);
  });
});
