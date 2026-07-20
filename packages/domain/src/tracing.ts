import {
  context,
  isSpanContextValid,
  propagation,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import { errorMessage } from './utils.js';

/** Shared tracer name for every span this codebase creates. */
export const TRACER_NAME = 'agent-foundry';

/**
 * Runs `fn` inside a new active span named `name` with `attributes` set at
 * creation. On throw, records the exception and an ERROR status before
 * rethrowing; the span always ends. A silent no-op wrapper — `fn` still
 * runs — when no SDK tracer provider is registered (the @opentelemetry/api
 * default).
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Injects the active trace context into a fresh carrier; empty when there is nothing to propagate (no provider, no active span). */
export function serializeTraceContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Runs `fn` with the trace context extracted from `carrier` made active; a no-op wrapper when `carrier` is missing or empty. */
export function withExtractedContext<T>(
  carrier: Record<string, string> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const extracted = propagation.extract(context.active(), carrier ?? {});
  return context.with(extracted, fn);
}

/** The active span's trace/span ids; empty when there is no valid active span. */
export function currentTraceIds(): { traceId?: string; spanId?: string } {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
