import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { EnvironmentIdentity, PreviewSession } from '@agent-foundry/contracts';
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

  it('records project, environment and source version on the run span (#617)', async () => {
    const initialize = vi.fn(
      async (_input: { projectId: string; identity?: EnvironmentIdentity }) => ({}) as never,
    );
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: { initialize } as never,
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const identity = initialize.mock.calls[0]![0].identity!;
    expect(identity.class).toBe('candidate');
    if (identity.class === 'manual-preview') throw new Error('unreachable');
    const runSpan = exporter.getFinishedSpans().find((span) => span.name === 'foundry.run');
    expect(runSpan?.attributes).toMatchObject({
      'foundry.project.id': 'project-1',
      'foundry.environment.id': 'run-1',
      'foundry.environment.class': 'candidate',
      'foundry.project.version.id': identity.projectVersionId,
    });
    // The version is the ledger entry the stack was bound to, not an invented id.
    expect(identity.projectVersionId).toBeTypeOf('string');
  });

  it('reuses the preserved candidate stack for a project retry', async () => {
    const environments: Array<{ identity: EnvironmentIdentity }> = [];
    const initialize = vi.fn(
      async (input: { projectId: string; identity?: EnvironmentIdentity }) => {
        if (input.identity && environments.length === 0)
          environments.push({ identity: input.identity });
        return {} as never;
      },
    );
    const listEnvironments = vi.fn(async () => environments as never);
    let active: PreviewSession | undefined;
    const activeForProject = vi.fn(async (_projectId: string, environmentId?: string | null) => {
      const matches =
        environmentId === null
          ? active?.workspaceRef.environmentId === undefined
          : active?.workspaceRef.environmentId === environmentId;
      return matches ? active : undefined;
    });
    const start = vi.fn(
      async (input: {
        workspaceRef: PreviewSession['workspaceRef'];
        runId?: string;
      }): Promise<{ session: PreviewSession; url: string }> => {
        const now = new Date().toISOString();
        active = {
          id: 'preview-retry',
          workspaceRef: input.workspaceRef,
          ...(input.runId ? { runId: input.runId } : {}),
          status: 'running',
          version: 1,
          health: { state: 'healthy', consecutiveFailures: 0 },
          ttl: { seconds: 60 },
          restartCount: 0,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        };
        return { session: active, url: 'http://127.0.0.1/preview' };
      },
    );
    const stop = vi.fn(async () => active!);
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: { initialize, listEnvironments } as never,
      previews: { activeForProject, start, renewForProject: vi.fn(), stop } as never,
    });
    const heartbeat = vi.spyOn(
      harness.orchestrator as unknown as {
        startPreviewLeaseHeartbeat(projectId: string, environmentId: string | null): () => void;
      },
      'startPreviewLeaseHeartbeat',
    );
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const original = initialize.mock.calls[0]![0].identity!;

    const retried = await harness.service.retry('project-1');
    if (!retried.currentRunId) throw new Error('retry has no run');
    await harness.orchestrator.runProject('project-1', undefined, retried.currentRunId);

    expect(initialize.mock.calls.at(-1)?.[0].identity).toEqual(original);
    const retryEvent = await harness.events.findLatest('project-1', {
      type: 'project.provisioned',
      runId: retried.currentRunId,
    });
    expect(retryEvent?.data.environment).toEqual(original);
    expect(heartbeat.mock.calls.at(-1)).toEqual(['project-1', original.environmentId]);

    const retryRun = await harness.runs.get(retried.currentRunId);
    if (!retryRun) throw new Error('retry run missing');
    await harness.runs.update({ ...retryRun, status: 'failed' }, retryRun.version);
    await (
      harness.orchestrator as unknown as {
        stopPreviewForFailedRun(projectId: string, runId: string): Promise<void>;
      }
    ).stopPreviewForFailedRun('project-1', retried.currentRunId);
    expect(activeForProject.mock.calls.at(-1)).toEqual(['project-1', original.environmentId]);
    expect(stop).toHaveBeenCalledWith('preview-retry');

    active = { ...active!, runId: retried.currentRunId };
    stop.mockClear();
    const secondRetry = await harness.service.retry('project-1');
    if (!secondRetry.currentRunId) throw new Error('second retry has no run');
    await harness.orchestrator.runProject('project-1', undefined, secondRetry.currentRunId);
    const secondRun = await harness.runs.get(secondRetry.currentRunId);
    if (!secondRun) throw new Error('second retry run missing');
    await harness.runs.update({ ...secondRun, status: 'failed' }, secondRun.version);
    await (
      harness.orchestrator as unknown as {
        stopPreviewForFailedRun(projectId: string, runId: string): Promise<void>;
      }
    ).stopPreviewForFailedRun('project-1', secondRetry.currentRunId);
    expect(stop).toHaveBeenCalledWith('preview-retry');
  });

  it('reuses the bound identity after provisioning fails before the stack exists', async () => {
    const initialize = vi
      .fn(async (_input: { projectId: string; identity?: EnvironmentIdentity }) => ({}) as never)
      .mockRejectedValueOnce(new Error('docker unavailable'));
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: {
        initialize,
        listEnvironments: async () => [],
      } as never,
    });
    await seedRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /provisioning failed/i,
    );
    const bound = await harness.events.findLatest('project-1', {
      type: 'project.provisioning_started',
      runId: 'run-1',
    });
    const retried = await harness.service.retry('project-1');
    if (!retried.currentRunId) throw new Error('retry has no run');

    await harness.orchestrator.runProject('project-1', undefined, retried.currentRunId);

    expect(bound?.data.environment).toBeDefined();
    expect(initialize.mock.calls.at(-1)?.[0].identity).toEqual(bound?.data.environment);
  });

  it('replays the same environment and version on a resumed run that provisioned earlier (#617)', async () => {
    const initialize = vi.fn(async () => ({}) as never);
    const listEnvironments = vi.fn();
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: { initialize, listEnvironments } as never,
    });
    await seedRun(harness);
    await harness.workspaces.ensureGit();
    const head = await harness.workspaces.head('project-1');
    if (!head) throw new Error('test workspace has no HEAD');
    const version = await harness.versions.baselineForRun('project-1', 'run-1', head);
    const identity = {
      class: 'candidate',
      projectId: 'project-1',
      environmentId: 'run-1',
      runCandidateId: 'run-1',
      projectVersionId: version.id,
    } as const;
    listEnvironments.mockResolvedValue([{ identity }] as never);
    const listVersions = vi.spyOn(harness.versions, 'list').mockResolvedValue([]);
    await harness.events.append({
      id: 'event-provisioned',
      projectId: 'project-1',
      runId: 'run-1',
      type: 'project.provisioned',
      createdAt: harness.clock.now().toISOString(),
      message: 'Project provisioning completed.',
      data: {
        environment: identity,
      },
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // Recovery validates the recorded identity against runtime metadata before
    // trusting it, then replays that same triple onto the resumed span.
    expect(listEnvironments).toHaveBeenCalledTimes(1);
    expect(listVersions).not.toHaveBeenCalled();
    expect(initialize).toHaveBeenCalledWith({
      projectId: 'project-1',
      identity: {
        class: 'candidate',
        projectId: 'project-1',
        environmentId: 'run-1',
        runCandidateId: 'run-1',
        projectVersionId: version.id,
      },
    });
    const runSpan = exporter.getFinishedSpans().find((span) => span.name === 'foundry.run');
    expect(runSpan?.attributes).toMatchObject({
      'foundry.project.id': 'project-1',
      'foundry.environment.id': 'run-1',
      'foundry.environment.class': 'candidate',
      'foundry.project.version.id': version.id,
    });
  });

  it('fails closed when a provisioned event has no persisted environment', async () => {
    const initialize = vi.fn(async () => ({}) as never);
    const listEnvironments = vi.fn(async () => []);
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: { initialize, listEnvironments } as never,
    });
    await seedRun(harness);
    await harness.events.append({
      id: 'event-provisioned-missing',
      projectId: 'project-1',
      runId: 'run-1',
      type: 'project.provisioned',
      createdAt: harness.clock.now().toISOString(),
      message: 'Project provisioning completed.',
      data: {
        environment: {
          class: 'candidate',
          projectId: 'project-1',
          environmentId: 'run-1',
          runCandidateId: 'run-1',
          projectVersionId: 'version-7',
        },
      },
    });

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /persisted environment/i,
    );
    expect(initialize).not.toHaveBeenCalled();
  });

  it('fails closed when recovered metadata names no ProjectVersion in the ledger', async () => {
    const identity = {
      class: 'candidate',
      projectId: 'project-1',
      environmentId: 'run-1',
      runCandidateId: 'run-1',
      projectVersionId: 'version-missing',
    } as const;
    const initialize = vi.fn(async () => ({}) as never);
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: {
        initialize,
        listEnvironments: async () => [{ identity }],
      } as never,
    });
    await seedRun(harness);
    await harness.events.append({
      id: 'event-provisioned-missing-version',
      projectId: 'project-1',
      runId: 'run-1',
      type: 'project.provisioned',
      createdAt: harness.clock.now().toISOString(),
      message: 'Project provisioning completed.',
      data: { environment: identity },
    });

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /ProjectVersion/i,
    );
    expect(initialize).not.toHaveBeenCalled();
  });

  it('preserves an explicitly legacy environment across retry', async () => {
    const initialize = vi.fn(async () => ({}) as never);
    let active: PreviewSession | undefined;
    const activeForProject = vi.fn(async (_projectId: string, environmentId?: string | null) =>
      environmentId === null && active?.workspaceRef.environmentId === undefined
        ? active
        : undefined,
    );
    const start = vi.fn(
      async (input: { workspaceRef: PreviewSession['workspaceRef']; runId?: string }) => {
        const now = new Date().toISOString();
        active = {
          id: `preview-${input.runId}`,
          workspaceRef: input.workspaceRef,
          ...(input.runId ? { runId: input.runId } : {}),
          status: 'running',
          version: 1,
          health: { state: 'healthy', consecutiveFailures: 0 },
          ttl: { seconds: 60 },
          restartCount: 0,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        } satisfies PreviewSession;
        return { session: active, url: 'http://127.0.0.1/preview' };
      },
    );
    const stop = vi.fn(async () => active!);
    const harness = makeHarness({}, undefined, {
      generatedProjectRuntime: { initialize } as never,
      previews: { activeForProject, start, renewForProject: vi.fn(), stop } as never,
    });
    const heartbeat = vi.spyOn(
      harness.orchestrator as unknown as {
        startPreviewLeaseHeartbeat(projectId: string, environmentId: string | null): () => void;
      },
      'startPreviewLeaseHeartbeat',
    );
    await seedRun(harness);
    await harness.events.append({
      id: 'event-provisioned-legacy',
      projectId: 'project-1',
      runId: 'run-1',
      type: 'project.provisioned',
      createdAt: harness.clock.now().toISOString(),
      message: 'Project provisioning completed.',
      data: {},
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    active = undefined; // the original legacy preview expired before manual retry
    const retried = await harness.service.retry('project-1');
    if (!retried.currentRunId) throw new Error('retry has no run');
    await harness.orchestrator.runProject('project-1', undefined, retried.currentRunId);

    expect(initialize).toHaveBeenLastCalledWith({ projectId: 'project-1' });
    const retryEvent = await harness.events.findLatest('project-1', {
      type: 'project.provisioned',
      runId: retried.currentRunId,
    });
    expect(retryEvent?.data.environment).toBeUndefined();
    expect(heartbeat.mock.calls.at(-1)).toEqual(['project-1', null]);

    const retryRun = await harness.runs.get(retried.currentRunId);
    if (!retryRun) throw new Error('retry run missing');
    await harness.runs.update({ ...retryRun, status: 'failed' }, retryRun.version);
    await (
      harness.orchestrator as unknown as {
        stopPreviewForFailedRun(projectId: string, runId: string): Promise<void>;
      }
    ).stopPreviewForFailedRun('project-1', retried.currentRunId);
    expect(activeForProject.mock.calls.at(-1)).toEqual(['project-1', null]);
    expect(stop).toHaveBeenCalledWith(`preview-${retried.currentRunId}`);
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
