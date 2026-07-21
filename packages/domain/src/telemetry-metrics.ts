import {
  metrics,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';
import { TRACER_NAME } from './tracing.js';

/**
 * Meter helpers for the `foundry.*` metric contract. Unlike `trace.getTracer`
 * (a ProxyTracer that cheaply resolves a cached delegate — see tracing.ts),
 * `metrics.getMeter` does NOT cheaply dedupe per call: `MetricsAPI.getMeter`
 * forwards straight to the current MeterProvider's `getMeter` every time —
 * a registry scan plus a wrapper allocation, with no delegate shortcut. So
 * instruments are memoized here instead of created fresh per call, keyed on
 * the *identity* of the Meter object `getMeter` returns: a MeterProvider
 * (including the shared no-op meter before an SDK one is registered) returns
 * the same Meter reference for a given name, so the cache only needs to
 * invalidate on the one transition where that reference actually changes —
 * `startTelemetry` registering a real MeterProvider.
 */

export interface TokenUsageAttributes {
  inputTokens?: number;
  outputTokens?: number;
  modelId: string;
}

interface Instruments {
  meter: Meter;
  runDuration: Histogram;
  stepRetries: Counter;
  queueWait: Histogram;
  tokensInput: Histogram;
  tokensOutput: Histogram;
}

let cachedInstruments: Instruments | undefined;

function currentInstruments(): Instruments {
  const meter = metrics.getMeter(TRACER_NAME);
  if (!cachedInstruments || cachedInstruments.meter !== meter) {
    cachedInstruments = {
      meter,
      runDuration: meter.createHistogram('foundry.run.duration_ms', { unit: 'ms' }),
      stepRetries: meter.createCounter('foundry.step.retries'),
      queueWait: meter.createHistogram('foundry.queue.wait_ms', { unit: 'ms' }),
      tokensInput: meter.createHistogram('foundry.tokens.input'),
      tokensOutput: meter.createHistogram('foundry.tokens.output'),
    };
  }
  return cachedInstruments;
}

export function recordRunDuration(ms: number, attributes: { status: string }): void {
  currentInstruments().runDuration.record(ms, attributes as Attributes);
}

export function recordStepRetry(): void {
  currentInstruments().stepRetries.add(1);
}

export function recordQueueWait(ms: number): void {
  currentInstruments().queueWait.record(ms);
}

export function recordTokenUsage(usage: TokenUsageAttributes): void {
  const { tokensInput, tokensOutput } = currentInstruments();
  const attributes: Attributes = { 'foundry.model.id': usage.modelId };
  if (usage.inputTokens !== undefined) {
    tokensInput.record(usage.inputTokens, attributes);
  }
  if (usage.outputTokens !== undefined) {
    tokensOutput.record(usage.outputTokens, attributes);
  }
}

let cachedActiveSessionsGauge: { meter: Meter; gauge: ObservableGauge } | undefined;

/**
 * Registers `cb` as the pull source for the `foundry.preview.active_sessions`
 * gauge: the SDK calls it once per metric export interval instead of on
 * every session mutation (see PreviewService, its sole caller). The gauge is
 * memoized the same way `currentInstruments` memoizes the synchronous
 * instruments above — recreated, and `cb` re-attached, only if the meter
 * identity has changed since the last call.
 */
export function registerActiveSessionsCallback(cb: () => Promise<number> | number): void {
  const meter = metrics.getMeter(TRACER_NAME);
  if (!cachedActiveSessionsGauge || cachedActiveSessionsGauge.meter !== meter) {
    cachedActiveSessionsGauge = {
      meter,
      gauge: meter.createObservableGauge('foundry.preview.active_sessions'),
    };
  }
  cachedActiveSessionsGauge.gauge.addCallback(async (result) => {
    result.observe(await cb());
  });
}
