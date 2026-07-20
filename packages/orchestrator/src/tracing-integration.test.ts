import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { makeHarness, rateLimitError, seedRun } from './testing/harness.js';

/**
 * Exercises the orchestrator's span coverage end to end: `foundry.run` →
 * `foundry.step` → `foundry.attempt`, all sharing one trace.
 *
 * The harness's ControllableExecutor implements ExecutionPlane/AgentExecutor
 * directly and never spawns a process, so it bypasses BaseCliExecutor
 * entirely — no `foundry.cli` span is reachable from here. That span is
 * covered separately by a unit test on BaseCliExecutor with a stubbed
 * `execa` process (see base-cli-executor.test.ts).
 */
describe('orchestrator span coverage', () => {
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

  it('produces one foundry.run trace with foundry.step and foundry.attempt descendants', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((span) => span.name === 'foundry.run');
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes).toMatchObject({
      'foundry.project.id': 'project-1',
      'foundry.run.id': 'run-1',
      'foundry.workflow.id': harness.workflow.id,
    });

    const stepSpans = spans.filter((span) => span.name === 'foundry.step');
    expect(stepSpans.length).toBeGreaterThan(0);
    for (const step of stepSpans) {
      expect(step.attributes['foundry.step.node_id']).toBeTypeOf('string');
      expect(step.attributes['foundry.step.id']).toBeTypeOf('string');
      expect(step.attributes['foundry.step.type']).toBeTypeOf('string');
    }

    const attemptSpans = spans.filter((span) => span.name === 'foundry.attempt');
    expect(attemptSpans.length).toBeGreaterThan(0);
    for (const attempt of attemptSpans) {
      expect(attempt.attributes['foundry.attempt.id']).toBeTypeOf('string');
      expect(attempt.attributes['foundry.attempt.sequence']).toBeTypeOf('number');
      expect(attempt.attributes['foundry.model.id']).toBeTypeOf('string');
      expect(attempt.attributes['foundry.provider']).toBeTypeOf('string');
    }

    // One trace end to end.
    const traceId = runSpan!.spanContext().traceId;
    for (const span of spans) expect(span.spanContext().traceId).toBe(traceId);

    // At least one step is a direct child of the run span, and at least one
    // attempt is a direct child of a step span — a real parent/child tree,
    // not just spans that happen to share a trace id.
    const runSpanId = runSpan!.spanContext().spanId;
    expect(stepSpans.some((step) => step.parentSpanContext?.spanId === runSpanId)).toBe(true);
    const stepSpanIds = new Set(stepSpans.map((step) => step.spanContext().spanId));
    expect(
      attemptSpans.some(
        (attempt) =>
          attempt.parentSpanContext?.spanId !== undefined &&
          stepSpanIds.has(attempt.parentSpanContext.spanId),
      ),
    ).toBe(true);

    // The mock executor never spawns a CLI process — see file header.
    expect(spans.some((span) => span.name === 'foundry.cli')).toBe(false);
  });

  it('marks a retried, ultimately-failing attempt ERROR with force_sample', async () => {
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: rateLimitError } },
      undefined,
      { fallback: true },
    );
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toThrow();

    const spans = exporter.getFinishedSpans();
    // 'plan' runs first and succeeds (1 attempt); 'implement' then exhausts
    // both fallback candidates and fails (2 attempts); 'review'/'verify'
    // never run. Scope the assertions to the two failed (implement) attempts
    // so the successful 'plan' attempt doesn't get swept in.
    const failedAttempts = spans
      .filter(
        (span) => span.name === 'foundry.attempt' && span.status.code === SpanStatusCode.ERROR,
      )
      .sort(
        (left, right) =>
          (left.attributes['foundry.attempt.sequence'] as number) -
          (right.attributes['foundry.attempt.sequence'] as number),
      );
    expect(failedAttempts).toHaveLength(2);

    const [first, second] = failedAttempts;
    // First candidate (sequence 1): force_sample is set reactively once the
    // attempt is known to have failed.
    expect(first?.attributes['foundry.attempt.sequence']).toBe(1);
    expect(first?.attributes['foundry.force_sample']).toBe(true);

    // The retry (sequence 2) is force-sampled both because it's a retry
    // (known at span start) and because it failed (set reactively).
    expect(second?.attributes['foundry.attempt.sequence']).toBe(2);
    expect(second?.attributes['foundry.force_sample']).toBe(true);
  });
});
