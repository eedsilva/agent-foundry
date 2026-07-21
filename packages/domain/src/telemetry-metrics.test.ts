import { afterEach, describe, expect, it, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type GaugeMetricData,
  type HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import {
  recordQueueWait,
  recordRunDuration,
  recordStepRetry,
  recordTokenUsage,
  registerActiveSessionsCallback,
} from './telemetry-metrics.js';

describe('telemetry metrics helpers with no MeterProvider registered', () => {
  it('are no-ops that never throw', () => {
    expect(() => recordRunDuration(10, { status: 'completed' })).not.toThrow();
    expect(() => recordStepRetry()).not.toThrow();
    expect(() => recordQueueWait(10)).not.toThrow();
    expect(() =>
      recordTokenUsage({ inputTokens: 1, outputTokens: 2, modelId: 'model-1' }),
    ).not.toThrow();
    expect(() => registerActiveSessionsCallback(() => 1)).not.toThrow();
  });
});

describe('telemetry metrics helpers with a registered MeterProvider', () => {
  afterEach(() => {
    metrics.disable();
  });

  it('recordQueueWait(1200) produces a histogram data point of 1200', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    recordQueueWait(1200);

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === 'foundry.queue.wait_ms');
    expect(metric?.dataPointType).toBe(DataPointType.HISTOGRAM);
    const point = (metric as HistogramMetricData).dataPoints[0];
    expect(point?.value.sum).toBe(1200);
    expect(point?.value.count).toBe(1);

    await provider.shutdown();
  });

  // Regression: registerActiveSessionsCallback wires an *observable* gauge —
  // the SDK pulls the value via the callback at collect() time rather than
  // it being pushed on every call, so the assertion has to go through
  // reader.collect() rather than reading a recorded value straight back.
  it('registerActiveSessionsCallback(cb) reports cb() as an observable gauge on collect()', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    registerActiveSessionsCallback(() => 3);

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === 'foundry.preview.active_sessions');
    expect(metric?.dataPointType).toBe(DataPointType.GAUGE);
    const point = (metric as GaugeMetricData).dataPoints[0];
    expect(point?.value).toBe(3);

    await provider.shutdown();
  });

  it('registerActiveSessionsCallback supports an async cb', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    registerActiveSessionsCallback(async () => {
      await Promise.resolve();
      return 5;
    });

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((candidate) => candidate.descriptor.name === 'foundry.preview.active_sessions');
    const point = (metric as GaugeMetricData).dataPoints[0];
    expect(point?.value).toBe(5);

    await provider.shutdown();
  });

  // Regression for the "bad order" bug: an entrypoint calling createRuntime
  // (and so constructing PreviewService) before startTelemetry means this
  // callback is first registered against the noop meter, whose addCallback
  // discards rather than queues it. Without replaying every stored callback
  // on the next meter-identity change, `early` below would never fire again
  // — orphaned forever on a gauge the SDK never collects from. Asserting
  // `early` was invoked (rather than reading the gauge's final value, which
  // multiple concurrently-attached callbacks would race to overwrite) is
  // what actually proves re-attachment happened, not just that a fresh call
  // still works.
  it('replays a callback registered before the real MeterProvider once a later call observes the new meter', async () => {
    const early = vi.fn(() => 4);
    registerActiveSessionsCallback(early); // bad order: only the noop meter exists yet

    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 100_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);

    // A later call (e.g. a second PreviewService, or telemetry finally
    // starting) is what notices the meter changed and replays every stored
    // callback, including `early`, onto the new real gauge.
    registerActiveSessionsCallback(() => 4);

    await reader.collect();
    expect(early).toHaveBeenCalled();

    await provider.shutdown();
  });
});
