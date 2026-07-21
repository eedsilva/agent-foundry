import {
  metrics,
  SamplingDecision,
  SpanStatusCode,
  TraceFlags,
  type Attributes,
  type Context,
  type Link,
  type Sampler,
  type SamplingResult,
  type SpanKind,
} from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { redactString } from '@agent-foundry/domain';

export interface TelemetryHandle {
  shutdown(): Promise<void>;
}

export interface TelemetryOptions {
  serviceName: string;
  /** OTLP-compatible collector endpoint (e.g. `http://localhost:4318`). Unset => inert: nothing is registered. */
  endpoint?: string | undefined;
  sampleRatio: number;
  slowRunThresholdMs: number;
}

const METRIC_EXPORT_INTERVAL_MS = 15_000;

/** True when the span's `foundry.run.duration_ms` attribute exceeds `thresholdMs`. */
function isSlowSpan(span: ReadableSpan, thresholdMs: number): boolean {
  const durationMs = span.attributes['foundry.run.duration_ms'];
  return typeof durationMs === 'number' && durationMs > thresholdMs;
}

/**
 * Wraps a delegate span exporter to redact secret-shaped string values (via
 * domain's `redactString`) — span attributes, the status message, and every
 * event's attributes/name (an `exception` event from `span.recordException`
 * carries `exception.message`/`exception.stacktrace`, which otherwise
 * bypasses attribute redaction entirely) — and to stamp `foundry.slow=true`
 * on spans whose `foundry.run.duration_ms` attribute exceeds
 * `slowRunThresholdMs` — a hook for collector-side tail-based retention of
 * slow traces; retention itself is the collector's job, not this exporter's.
 *
 * Mutates the `ReadableSpan` in place rather than cloning it: the
 * `attributes`/`status`/`events` *property bindings* are readonly but the
 * objects they point to are not, while `ReadableSpan.spanContext` is a
 * prototype method that a shallow `{...span}` clone would silently drop.
 */
export class RedactingSpanExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly slowRunThresholdMs: number,
  ) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    for (const span of spans) {
      for (const [key, value] of Object.entries(span.attributes)) {
        if (typeof value === 'string') span.attributes[key] = redactString(value);
      }
      if (typeof span.status.message === 'string') {
        span.status.message = redactString(span.status.message);
      }
      for (const event of span.events) {
        if (event.attributes) {
          for (const [key, value] of Object.entries(event.attributes)) {
            if (typeof value === 'string') event.attributes[key] = redactString(value);
          }
        }
        event.name = redactString(event.name);
      }
      if (isSlowSpan(span, this.slowRunThresholdMs)) {
        span.attributes['foundry.slow'] = true;
      }
    }
    this.delegate.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * Samples like `ParentBased(TraceIdRatioBased(ratio))`, except:
 *
 * 1. a span whose initial attributes carry `foundry.force_sample === true`
 *    (a fallback-candidate retry — see workflow-orchestrator) is always
 *    RECORD_AND_SAMPLED regardless of ratio, so it's known-exported the
 *    moment it starts;
 * 2. every other span that the ratio sampler would have dropped
 *    (NOT_RECORD) is downgraded only to RECORD instead — recording, but not
 *    sampled. NOT_RECORD spans are non-recording: `setStatus`,
 *    `setAttribute`, and `recordException` on them are silent no-ops, so a
 *    span's own catch block can't reactively flag itself (e.g.
 *    `span.setAttribute('foundry.force_sample', true)` after the fact, as
 *    workflow-orchestrator and conversation-operation-runner do) — the
 *    sampling decision already happened before the failure was known. RECORD
 *    keeps the span's data alive through `onEnd`, where `TailSpanProcessor`
 *    makes the real export decision once the outcome (status, attributes,
 *    duration) is known. This applies uniformly to root and child spans:
 *    KeepErrorsSampler is the sole entry point the SDK calls for both (a
 *    root-only fix would leave every nested `foundry.attempt`/`foundry.step`
 *    span dropped whenever its ancestor wasn't head-sampled).
 */
export class KeepErrorsSampler implements Sampler {
  private readonly delegate: Sampler;

  constructor(ratio: number) {
    this.delegate = new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
  }

  shouldSample(
    context: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (attributes['foundry.force_sample'] === true) {
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
    }
    const result = this.delegate.shouldSample(
      context,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
    if (result.decision === SamplingDecision.NOT_RECORD) {
      return { ...result, decision: SamplingDecision.RECORD };
    }
    return result;
  }

  toString(): string {
    return `KeepErrorsSampler{${this.delegate.toString()}}`;
  }
}

/**
 * Wraps a `BatchSpanProcessor` to add an export-time (tail) decision on top
 * of its head-sampled one. `KeepErrorsSampler` now records every span
 * (never NOT_RECORD) so a span's data — status, attributes, duration — is
 * complete by `onEnd` even when the head sampler would have dropped it; this
 * processor is where that data actually gets used. `BatchSpanProcessor.onEnd`
 * silently ignores any span without the SAMPLED trace flag, so a
 * recorded-but-unsampled span that turned out to matter (error, forced, or
 * slow) is exported directly here, once, via the same exporter instance
 * (so it still gets redacted/slow-stamped by `RedactingSpanExporter`).
 *
 * ponytail: this keeps every recorded span's data in memory until it ends,
 * which is acceptable at this app's scale; a collector-side tail sampler
 * (spans always exported, retention decided downstream) is the upgrade if
 * that stops being true.
 */
export class TailSpanProcessor implements SpanProcessor {
  constructor(
    private readonly delegate: SpanProcessor,
    private readonly exporter: SpanExporter,
    private readonly slowRunThresholdMs: number,
  ) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.delegate.onEnd(span);
    const alreadySampled = (span.spanContext().traceFlags & TraceFlags.SAMPLED) !== 0;
    if (alreadySampled || !this.shouldKeep(span)) return;
    this.exporter.export([span], () => {
      // best-effort: a dropped "kept" span is a lesser evil than throwing from onEnd
    });
  }

  private shouldKeep(span: ReadableSpan): boolean {
    if (span.status.code === SpanStatusCode.ERROR) return true;
    if (span.attributes['foundry.force_sample'] === true) return true;
    return isSlowSpan(span, this.slowRunThresholdMs);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

/**
 * Wires the OTel SDK by hand — a `NodeTracerProvider` (KeepErrorsSampler +
 * TailSpanProcessor wrapping a BatchSpanProcessor over a
 * RedactingSpanExporter) and a `MeterProvider` (OTLP metric exporter, 15s
 * interval) — and registers both globally. No `NodeSDK`, no
 * auto-instrumentation, no bundled collector: `endpoint` is whatever
 * OTLP-compatible target the operator points at.
 *
 * `endpoint` unset returns an inert handle: nothing is registered, so
 * `withSpan` and the `telemetry-metrics` helpers stay the @opentelemetry/api
 * no-ops they already are without an SDK.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  if (!options.endpoint) {
    return { shutdown: async () => {} };
  }
  const endpoint = options.endpoint;

  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName });

  const traceExporter = new RedactingSpanExporter(
    new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    options.slowRunThresholdMs,
  );
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new KeepErrorsSampler(options.sampleRatio),
    spanProcessors: [
      new TailSpanProcessor(
        new BatchSpanProcessor(traceExporter),
        traceExporter,
        options.slowRunThresholdMs,
      ),
    ],
  });
  tracerProvider.register();

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}
