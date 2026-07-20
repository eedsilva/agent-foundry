import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import {
  recordPreviewSessions,
  recordQueueWait,
  recordRunDuration,
  recordStepRetry,
  recordTokenUsage,
} from './telemetry-metrics.js';

describe('telemetry metrics helpers with no MeterProvider registered', () => {
  it('are no-ops that never throw', () => {
    expect(() => recordRunDuration(10, { status: 'completed' })).not.toThrow();
    expect(() => recordStepRetry()).not.toThrow();
    expect(() => recordQueueWait(10)).not.toThrow();
    expect(() =>
      recordTokenUsage({ inputTokens: 1, outputTokens: 2, modelId: 'model-1' }),
    ).not.toThrow();
    expect(() => recordPreviewSessions(1)).not.toThrow();
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
});
