import { metrics, type Attributes } from '@opentelemetry/api';
import { TRACER_NAME } from './tracing.js';

/**
 * Meter helpers for the `foundry.*` metric contract. Each function resolves
 * `metrics.getMeter(TRACER_NAME)` and creates its instrument fresh on every
 * call rather than caching one at module load: the metrics API (unlike the
 * trace API) has no proxy/delegate indirection, so an instrument created
 * before a MeterProvider is registered would stay bound to the no-op meter
 * forever. Creating per-call is cheap — the SDK dedupes storage by
 * descriptor — and keeps these helpers correctly no-op until
 * `startTelemetry` (packages/composition) registers a real MeterProvider.
 */

export interface TokenUsageAttributes {
  inputTokens?: number;
  outputTokens?: number;
  modelId: string;
}

export function recordRunDuration(ms: number, attributes: { status: string }): void {
  metrics
    .getMeter(TRACER_NAME)
    .createHistogram('foundry.run.duration_ms', { unit: 'ms' })
    .record(ms, attributes as Attributes);
}

export function recordStepRetry(): void {
  metrics.getMeter(TRACER_NAME).createCounter('foundry.step.retries').add(1);
}

export function recordQueueWait(ms: number): void {
  metrics.getMeter(TRACER_NAME).createHistogram('foundry.queue.wait_ms', { unit: 'ms' }).record(ms);
}

export function recordTokenUsage(usage: TokenUsageAttributes): void {
  const meter = metrics.getMeter(TRACER_NAME);
  const attributes: Attributes = { 'foundry.model.id': usage.modelId };
  if (usage.inputTokens !== undefined) {
    meter.createHistogram('foundry.tokens.input').record(usage.inputTokens, attributes);
  }
  if (usage.outputTokens !== undefined) {
    meter.createHistogram('foundry.tokens.output').record(usage.outputTokens, attributes);
  }
}

export function recordPreviewSessions(active: number): void {
  metrics.getMeter(TRACER_NAME).createGauge('foundry.preview.active_sessions').record(active);
}
