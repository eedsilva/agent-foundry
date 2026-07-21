import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { EmergencyCeilingError, type Clock } from '@agent-foundry/domain';
import { makeHarness, makeStores, rateLimitError, seedRun } from './testing/harness.js';

// Deterministic clock only advances when told to — mirrors the one in
// emergency-ceiling.test.ts, used here to force the four-hour active-time
// ceiling to trip from inside a failing attempt.
class TestClock implements Clock {
  constructor(private time = Date.parse('2026-07-16T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.time);
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

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

  // Regression for the force_sample gap: executeAgentAttempt's catch block
  // used to throw EmergencyCeilingError (a durable-failure path, distinct
  // from cancellation) before the span was marked ERROR/force_sample. Here
  // the 'implement' step's failure advances a deterministic clock past the
  // four-hour active-time ceiling, so classifyFailure reclassifies the
  // failure as EmergencyCeilingError — exercising exactly that path.
  it('marks the attempt span ERROR with force_sample when the attempt fails via EmergencyCeilingError', async () => {
    const clock = new TestClock();
    const stores = makeStores(clock);
    const failure = (): never => {
      clock.advance(14_400_000);
      throw new Error('implement failed');
    };
    const harness = makeHarness({ implement: { kind: 'fail-always', error: failure } }, stores);
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    const spans = exporter.getFinishedSpans();
    const failedAttempts = spans.filter(
      (span) => span.name === 'foundry.attempt' && span.status.code === SpanStatusCode.ERROR,
    );
    expect(failedAttempts).toHaveLength(1);
    expect(failedAttempts[0]?.attributes['foundry.force_sample']).toBe(true);
  });
});
