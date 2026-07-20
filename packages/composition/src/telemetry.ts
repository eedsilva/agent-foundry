import {
  metrics,
  SamplingDecision,
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
  type SpanExporter,
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

/**
 * Wraps a delegate span exporter to redact secret-shaped string attribute
 * values (via domain's `redactString`) and to stamp `foundry.slow=true` on
 * spans whose `foundry.run.duration_ms` attribute exceeds
 * `slowRunThresholdMs` — a hook for collector-side tail-based retention of
 * slow traces; retention itself is the collector's job, not this exporter's.
 *
 * Mutates `ReadableSpan.attributes` in place rather than cloning the span:
 * the `attributes` *property binding* is readonly but the object it points
 * to is not, while `ReadableSpan.spanContext` is a prototype method that a
 * shallow `{...span}` clone would silently drop.
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
      const durationMs = span.attributes['foundry.run.duration_ms'];
      if (typeof durationMs === 'number' && durationMs > this.slowRunThresholdMs) {
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
 * Samples like `ParentBased(TraceIdRatioBased(ratio))`, except a span whose
 * initial attributes carry `foundry.force_sample === true` (errors, retries
 * — see workflow-orchestrator) is always RECORD_AND_SAMPLED regardless of
 * ratio, so failures survive head sampling.
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
    return this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  toString(): string {
    return `KeepErrorsSampler{${this.delegate.toString()}}`;
  }
}

/**
 * Wires the OTel SDK by hand — a `NodeTracerProvider` (KeepErrorsSampler +
 * BatchSpanProcessor over a RedactingSpanExporter) and a `MeterProvider`
 * (OTLP metric exporter, 15s interval) — and registers both globally. No
 * `NodeSDK`, no auto-instrumentation, no bundled collector: `endpoint` is
 * whatever OTLP-compatible target the operator points at.
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
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
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
