import { describe, expect, it, vi } from 'vitest';
import { ResumeBlockedError } from '@agent-foundry/domain';
import { completeRun, liveStepRun, makeHarness, makeStores, seedRun } from './testing/harness.js';

describe('pause and resume at step boundaries (#7)', () => {
  it('pauses between steps, records the snapshot, and never starts the next step', async () => {
    const harness = makeHarness({ plan: 'gated' });
    await seedRun(harness);

    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('plan')).toBe(1);
    });
    await harness.service.pauseRun('run-1');
    // Idempotent: a second pause is a no-op.
    await harness.service.pauseRun('run-1');
    harness.executor.release('plan');
    await running; // resolves cleanly: the worker acks a paused run

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('paused');
    expect(run?.pause?.resumeNodeId).toBe('implement');
    expect(run?.pause?.workflowHash).toMatch(/^[a-f0-9]{64}$/);
    expect(run?.pause?.harnessVersion).toBe('harness-1');
    expect(run?.pause?.workspaceHead).toBe('initial-head');
    expect(run?.pause?.artifactHashes).toHaveProperty('plan');

    expect(harness.stepRuns.byStepId('run-1', 'plan')[0]?.status).toBe('completed');
    expect(harness.executor.started('implement')).toBe(0);
    expect((await harness.projects.get('project-1'))?.status).toBe('paused');
    expect(harness.events.types().filter((type) => type === 'run.pause_requested')).toHaveLength(1);
    expect(harness.events.types()).toContain('run.paused');
  });

  it('resumes after an API/worker restart without repeating completed side effects', async () => {
    const stores = makeStores();
    const first = makeHarness({ plan: 'gated' }, stores);
    await seedRun(first);
    const running = first.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(first.executor.started('plan')).toBe(1);
    });
    await first.service.pauseRun('run-1');
    first.executor.release('plan');
    await running;

    // Fresh orchestrator/service instances over the same persisted state.
    const second = makeHarness({}, stores);
    const resumed = await second.service.resumeRun('run-1');
    expect(resumed.status).toBe('queued');
    expect(second.enqueued).toHaveLength(1);

    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    const run = await second.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.pause).toBeUndefined();
    // The completed plan step was reused, not re-executed.
    expect(second.executor.started('plan')).toBe(0);
    expect(stores.artifacts.named('plan')).toHaveLength(1);
    expect(second.executor.started('implement')).toBe(1);
    expect(second.executor.started('review')).toBe(1);
    expect(stores.workspaces.commits).toHaveLength(1);
    expect(stores.events.types()).toContain('step.reused');
    // Dedupe keys keep the replayed lifecycle events single.
    expect(stores.events.types().filter((type) => type === 'project.started')).toHaveLength(1);
    expect((await stores.projects.get('project-1'))?.status).toBe('completed');
  });

  it('blocks resume with actionable diagnostics when workspace or inputs drifted', async () => {
    const harness = makeHarness({ plan: 'gated' });
    await seedRun(harness);
    const running = harness.orchestrator.runProject('project-1', undefined, 'run-1');
    await vi.waitFor(() => {
      expect(harness.executor.started('plan')).toBe(1);
    });
    await harness.service.pauseRun('run-1');
    harness.executor.release('plan');
    await running;

    // Drift: workspace HEAD moved and the plan artifact was edited.
    harness.workspaces.current = 'tampered-head';
    await harness.artifacts.put({
      projectId: 'project-1',
      name: 'plan',
      content: 'edited by hand',
      createdBy: 'user',
    });

    const rejection = harness.service.resumeRun('run-1');
    await expect(rejection).rejects.toThrow(ResumeBlockedError);
    const error = (await rejection.catch((cause: unknown) => cause)) as ResumeBlockedError;
    const fields = error.diagnostics.map((item) => item.field);
    expect(fields).toContain('workspaceHead');
    expect(fields).toContain('artifact:plan');

    expect((await harness.runs.get('run-1'))?.status).toBe('paused');
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.events.types()).toContain('run.resume_blocked');
  });
});

describe('step retry with controlled invalidation (#8)', () => {
  it('retries only the reviewer and preserves downstream outputs', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const review = liveStepRun(harness, 'review');

    await harness.service.retryStep('run-1', review.id, { mode: 'preserve' });
    const requeued = await harness.runs.get('run-1');
    expect(requeued?.status).toBe('queued');
    expect(requeued?.retry?.stepId).toBe('review');
    expect((await harness.stepRuns.get('run-1', review.id))?.invalidatedAt).toBeDefined();

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('plan')).toBe(1);
    expect(harness.executor.started('implement')).toBe(1);
    expect(harness.executor.started('review')).toBe(2);
    expect(harness.artifacts.named('review')).toHaveLength(2);
    expect(harness.artifacts.named('verification-report')).toHaveLength(1);
    // History preserved: the original review step run still exists.
    expect(harness.stepRuns.byStepId('run-1', 'review')).toHaveLength(2);
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(run?.retry).toBeUndefined();
    expect(harness.events.types()).toContain('step.retry_requested');
  });

  it('preserve mode keeps downstream outputs even when their inputs changed', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');

    await harness.service.retryStep('run-1', implement.id, { mode: 'preserve' });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.artifacts.named('implementation')).toHaveLength(2);
    // review consumed implementation r1, r2 now exists — preserved anyway.
    expect(harness.executor.started('review')).toBe(1);
    expect(harness.artifacts.named('review')).toHaveLength(1);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('retries the developer from its checkpoint, invalidates downstream, and honors the model override', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const implement = liveStepRun(harness, 'implement');
    const originalAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === implement.id);
    expect(originalAttempt?.checkpoint).toBeDefined();
    expect(originalAttempt?.commit).toBeDefined();

    const plan = await harness.service.retryPlan('run-1', implement.id);
    expect(plan.downstream.map((step) => step.stepId)).toEqual(['review', 'verify']);
    expect(plan.artifacts).toContain('review');
    expect(plan.artifacts).toContain('verification-report');

    await harness.service.retryStep('run-1', implement.id, {
      mode: 'invalidate',
      override: {
        modelId: 'model-2',
        provider: 'codex',
        model: 'alt-model',
        actor: { kind: 'user', id: 'ed' },
        reason: 'Retry on the alternate model',
        estimatedImpact: 'Avoid the prior model failure',
      },
    });
    for (const stepId of ['implement', 'review', 'verify']) {
      expect(
        harness.stepRuns
          .byStepId('run-1', stepId)
          .every((step) => step.invalidatedAt !== undefined),
      ).toBe(true);
    }

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // Mutable step restarted from the checkpoint its original attempt recorded.
    expect(harness.workspaces.rollbacks).toContain(originalAttempt!.checkpoint!);
    expect(harness.executor.started('plan')).toBe(1);
    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.executor.started('review')).toBe(2);
    expect(harness.artifacts.named('implementation')).toHaveLength(2);
    expect(harness.artifacts.named('review')).toHaveLength(2);
    expect(harness.artifacts.named('verification-report')).toHaveLength(2);

    const newImplement = liveStepRun(harness, 'implement');
    const newAttempt = harness.stepAttempts
      .all()
      .find((attempt) => attempt.stepRunId === newImplement.id);
    expect(newAttempt?.modelId).toBe('model-2');
    expect(newAttempt?.model).toBe('alt-model');
    // Old attempt history is untouched.
    expect(
      await harness.stepAttempts.get('run-1', implement.id, originalAttempt!.id),
    ).toMatchObject({ status: 'succeeded' });
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('rejects retry while the run is not finished and rejects unknown overrides', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const review = liveStepRun(harness, 'review');

    await expect(
      harness.service.retryStep('run-1', review.id, {
        mode: 'preserve',
        override: {
          modelId: 'missing-model',
          provider: 'codex',
          model: 'not-a-model',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Test an unknown model',
          estimatedImpact: 'No execution expected',
        },
      }),
    ).rejects.toThrow(/not enabled/);

    await harness.service.retryStep('run-1', review.id, { mode: 'preserve' });
    await expect(
      harness.service.retryStep('run-1', review.id, { mode: 'preserve' }),
    ).rejects.toThrow(/only completed or failed runs/);
  });

  it('rejects a model pin for a verify retry before mutating or queueing the run', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const verify = liveStepRun(harness, 'verify');
    const before = await harness.runs.get('run-1');
    const queueCount = harness.enqueued.length;

    await expect(
      harness.service.retryStep('run-1', verify.id, {
        mode: 'invalidate',
        override: {
          modelId: 'model-1',
          provider: 'codex',
          model: 'test-model',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Try to pin a verifier',
          estimatedImpact: 'No mutation expected',
        },
      }),
    ).rejects.toThrow(/only agent steps support model overrides/);

    expect(await harness.runs.get('run-1')).toEqual(before);
    expect(await harness.stepRuns.get('run-1', verify.id)).toEqual(verify);
    expect(harness.enqueued).toHaveLength(queueCount);
    expect(harness.events.types()).not.toContain('step.retry_requested');
  });
});

describe('idempotency across attempts, artifacts, events and commits (#9)', () => {
  it('crash after artifact put: replay adopts the artifact without re-executing or re-committing', async () => {
    const harness = makeHarness();
    await seedRun(harness);
    harness.artifacts.onAfterPut = (name) => {
      if (name === 'implementation') harness.power.on = false;
    };

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /simulated power loss/,
    );
    harness.artifacts.onAfterPut = undefined;
    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    expect(harness.workspaces.commits).toHaveLength(1);

    harness.power.on = true;
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // The step did not run again; its interrupted records were finalized.
    expect(harness.executor.started('implement')).toBe(1);
    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    expect(harness.workspaces.commits).toHaveLength(1);
    const implement = liveStepRun(harness, 'implement');
    expect(implement.status).toBe('completed');
    const attempts = await harness.stepAttempts.list('run-1', implement.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('succeeded');
    expect(attempts[0]?.outputArtifacts[0]?.name).toBe('implementation');
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(harness.events.types()).toContain('step.reused');
  });

  it('crash after commit but before artifact put: replay re-executes without duplicating the artifact', async () => {
    const harness = makeHarness();
    await seedRun(harness);
    harness.workspaces.onAfterCommit = () => {
      harness.power.on = false;
    };

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /simulated power loss/,
    );
    harness.workspaces.onAfterCommit = undefined;
    expect(harness.artifacts.named('implementation')).toHaveLength(0);

    harness.power.on = true;
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.artifacts.named('implementation')).toHaveLength(1);
    const stepRuns = harness.stepRuns.byStepId('run-1', 'implement');
    expect(stepRuns).toHaveLength(2);
    expect(stepRuns[0]?.status).toBe('failed');
    expect(stepRuns[0]?.error?.message).toMatch(/Interrupted/);
    expect(stepRuns[1]?.status).toBe('completed');
    // The interrupted attempt is preserved as failed history, never rewritten.
    const staleAttempts = await harness.stepAttempts.list('run-1', stepRuns[0]!.id);
    expect(staleAttempts[0]?.status).toBe('failed');
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('crash before queue ack: redelivery of a completed run is a no-op', async () => {
    const harness = makeHarness();
    await completeRun(harness);
    const stepCount = harness.stepRuns.store.size;
    const attemptCount = harness.stepAttempts.store.size;
    const artifactCount = harness.artifacts.artifacts.length;
    const eventCount = harness.events.events.length;

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.stepRuns.store.size).toBe(stepCount);
    expect(harness.stepAttempts.store.size).toBe(attemptCount);
    expect(harness.artifacts.artifacts.length).toBe(artifactCount);
    expect(harness.events.events.length).toBe(eventCount);
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
  });

  it('keeps the run -> step -> attempt -> artifact -> commit trail queryable', async () => {
    const harness = makeHarness();
    await completeRun(harness);

    const detail = await harness.service.getRunDetail('run-1');
    expect(detail.run.id).toBe('run-1');
    expect(detail.steps.map((entry) => entry.step.stepId)).toEqual([
      'plan',
      'implement',
      'review',
      'verify',
    ]);
    const implement = detail.steps.find((entry) => entry.step.stepId === 'implement');
    const attempt = implement?.attempts[0];
    expect(attempt?.status).toBe('succeeded');
    expect(attempt?.commit).toBe(harness.workspaces.commits[0]);
    const output = attempt?.outputArtifacts[0];
    expect(output?.name).toBe('implementation');
    const artifact = await harness.artifacts.getRevision(
      'project-1',
      output!.name,
      output!.revision,
    );
    expect(artifact?.metadata.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });
});
