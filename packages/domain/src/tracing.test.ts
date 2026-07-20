import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import {
  TRACER_NAME,
  currentTraceIds,
  serializeTraceContext,
  withExtractedContext,
  withSpan,
} from './tracing.js';

describe('tracing helpers with a registered SDK provider', () => {
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

  it('records the span name and attributes and resolves with fn result', async () => {
    const result = await withSpan('foundry.test', { 'foundry.test.id': 'a' }, async (span) => {
      expect(span.isRecording()).toBe(true);
      return 'ok';
    });

    expect(result).toBe('ok');
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('foundry.test');
    expect(span?.attributes).toMatchObject({ 'foundry.test.id': 'a' });
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records the exception and ERROR status, ends the span, and rethrows', async () => {
    await expect(
      withSpan('foundry.test', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.status.message).toBe('boom');
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
    expect(span?.ended).toBe(true);
  });

  it('round-trips a serialized parent context into a linked child span', async () => {
    let carrier: Record<string, string> = {};
    let parentTraceId = '';

    await withSpan('foundry.parent', {}, async (parentSpan) => {
      parentTraceId = parentSpan.spanContext().traceId;
      carrier = serializeTraceContext();
    });

    let childTraceId = '';
    await withExtractedContext(carrier, () =>
      withSpan('foundry.child', {}, async () => {
        childTraceId = currentTraceIds().traceId ?? '';
        return undefined;
      }),
    );

    expect(parentTraceId).not.toBe('');
    expect(childTraceId).toBe(parentTraceId);
  });
});

describe('tracing helpers with no SDK provider registered', () => {
  it('withSpan still runs fn and resolves/rejects normally, without throwing itself', async () => {
    await expect(withSpan('foundry.test', {}, async () => 'value')).resolves.toBe('value');
    await expect(
      withSpan('foundry.test', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('serializeTraceContext returns an empty carrier', () => {
    expect(serializeTraceContext()).toEqual({});
  });

  it('withExtractedContext still runs fn with or without a carrier', async () => {
    await expect(withExtractedContext(undefined, async () => 'ran')).resolves.toBe('ran');
    await expect(withExtractedContext({ traceparent: 'bogus' }, async () => 'ran')).resolves.toBe(
      'ran',
    );
  });

  it('currentTraceIds returns an empty object', () => {
    expect(currentTraceIds()).toEqual({});
  });
});

it('TRACER_NAME is the shared tracer name contract', () => {
  expect(TRACER_NAME).toBe('agent-foundry');
});
