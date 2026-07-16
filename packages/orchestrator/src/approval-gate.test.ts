import { describe, expect, it } from 'vitest';
import { makeHarness, makeStores, seedRun } from './testing/harness.js';

describe('approval gates halt the run for a human decision (#13)', () => {
  it('approves and advances to completion', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');
    // #14: the project summary must mirror this, not fall back to "running".
    expect((await harness.projects.get('project-1'))?.status).toBe('awaiting_approval');

    const approvals = await harness.service.listApprovals('run-1');
    expect(approvals).toHaveLength(1);
    const { request, decision } = approvals[0]!;
    expect(decision).toBeNull();
    expect(request.nodeId).toBe('gate');
    expect(request.artifact.name).toBe('review');
    expect(request.allowedActions).toEqual(['approve', 'reject']);

    const decided = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    expect(decided.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('completed');
    expect(harness.executor.started('review')).toBe(1);
    expect(harness.artifacts.named('gate-decision')).toHaveLength(1);
    expect(harness.events.types()).toContain('run.approval_requested');
    expect(harness.events.types()).toContain('run.approval_decided');
  });

  it('rejects and ends the run when no return step is configured', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    await harness.service.decideApproval('run-1', request.id, {
      action: 'reject',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('rejected');
    expect(run?.completedAt).toBeDefined();
    expect(harness.events.types()).toContain('run.rejected');
    // #14: the project summary must mirror this, not fall back to "running".
    expect((await harness.projects.get('project-1'))?.status).toBe('rejected');
  });

  it('rejects with return-to-step: rewinds the repair step and re-halts with a fresh request', async () => {
    const harness = makeHarness({}, undefined, {
      gate: { onReject: 'return-to-step', returnToStepId: 'implement' },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [firstEntry] = await harness.service.listApprovals('run-1');
    const { request: firstRequest } = firstEntry!;

    await harness.service.decideApproval('run-1', firstRequest.id, {
      action: 'reject',
      decidedBy: 'ed',
      note: 'not quite right',
    });
    const afterDecision = await harness.runs.get('run-1');
    expect(afterDecision?.status).toBe('queued');
    expect(afterDecision?.retry?.stepId).toBe('implement');

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // The repair step and everything after it (including the gate itself)
    // re-executed; a brand new approval request is now pending.
    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.executor.started('review')).toBe(2);
    expect(harness.executor.started('verify')).toBe(0);
    expect(harness.stepRuns.byStepId('run-1', 'gate')).toHaveLength(2);

    const approvals = await harness.service.listApprovals('run-1');
    expect(approvals).toHaveLength(2);
    const second = approvals.find((entry) => entry.request.id !== firstRequest.id)!;
    expect(second.decision).toBeNull();
    const run = await harness.runs.get('run-1');
    expect(run?.status).toBe('awaiting_approval');

    // Approving the second request completes the run and clears the stale
    // retry directive left over from the rewind.
    await harness.service.decideApproval('run-1', second.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const finalRun = await harness.runs.get('run-1');
    expect(finalRun?.status).toBe('completed');
    expect(finalRun?.retry).toBeUndefined();
    // implement did not spuriously re-execute a third time.
    expect(harness.executor.started('implement')).toBe(2);
  });

  it('request-changes writes a repair artifact, rewinds, and re-halts', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    const decided = await harness.service.decideApproval('run-1', request.id, {
      action: 'request-changes',
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
      note: 'please add tests; Authorization: Bearer abcdef1234567890ABCDEF',
    });
    expect(decided.decision).toMatchObject({
      decidedBy: 'Ed',
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
      note: 'please add tests; Authorization: [REDACTED]',
    });
    const retry = (await harness.runs.get('run-1'))?.retry;
    expect(retry?.feedbackArtifact).toMatchObject({
      name: 'repair-notes',
      revision: 1,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.artifacts.named('repair-notes')).toHaveLength(1);
    const feedback = harness.artifacts.named('repair-notes')[0]!;
    expect(feedback.content).toMatchObject({
      schemaVersion: '1',
      note: 'please add tests; Authorization: [REDACTED]',
      actor: { kind: 'user', id: 'ed' },
      sourceRequestId: request.id,
      sourceDecisionId: decided.decision.id,
      runId: 'run-1',
      stepRunId: request.stepRunId,
    });
    expect(feedback.metadata).toMatchObject({
      kind: 'feedback',
      actor: { kind: 'user', id: 'ed' },
      sourceDecisionId: decided.decision.id,
    });
    expect(
      harness.events.events.find((event) => event.type === 'run.approval_decided')?.data,
    ).toMatchObject({ decidedBy: 'Ed' });
    expect(
      (await harness.service.exportRunAudit('run-1')).entries.find(
        (entry) => entry.kind === 'approval-decision',
      ),
    ).toMatchObject({ decision: { decidedBy: 'Ed', actor: { id: 'ed', displayName: 'Ed' } } });
    const activeImplement = harness.stepRuns
      .byStepId('run-1', 'implement')
      .find((step) => !step.invalidatedAt)!;
    const [repairAttempt] = await harness.stepAttempts.list('run-1', activeImplement.id);
    expect(repairAttempt?.inputArtifacts).toContainEqual(retry?.feedbackArtifact);
    const runRecord = harness.artifacts.named(`run-${repairAttempt!.id}`)[0]!;
    expect((runRecord.content as { requestMarkdown: string }).requestMarkdown).toContain(
      `SHA-256: ${retry!.feedbackArtifact!.sha256}`,
    );
    expect(harness.executor.started('implement')).toBe(2);
    const approvals = await harness.service.listApprovals('run-1');
    expect(approvals).toHaveLength(2);
    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');
  });

  it('rejects ambiguous actor and decidedBy service input', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');

    await expect(
      harness.service.decideApproval('run-1', entry!.request.id, {
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
        decidedBy: 'someone-else',
      }),
    ).rejects.toThrow(/exactly one identity/);
    expect((await harness.service.listApprovals('run-1'))[0]?.decision).toBeNull();
  });

  it('stores one feedback artifact when identical request-changes decisions race', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.artifacts.onListMetadata = async () => {
      reads += 1;
      if (reads === 2) release();
      await bothRead;
    };

    const results = await Promise.allSettled([
      harness.service.decideApproval('run-1', entry!.request.id, {
        action: 'request-changes',
        decidedBy: 'ed',
        note: 'add tests',
      }),
      harness.service.decideApproval('run-1', entry!.request.id, {
        action: 'request-changes',
        decidedBy: 'ed',
        note: 'add tests',
      }),
    ]);

    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(harness.artifacts.named('repair-notes')).toHaveLength(1);
  });

  it('halts idempotently across a worker restart before any decision arrives', async () => {
    const stores = makeStores();
    const first = makeHarness({}, stores, { gate: {} });
    await seedRun(first);
    await first.orchestrator.runProject('project-1', undefined, 'run-1');
    expect((await first.runs.get('run-1'))?.status).toBe('awaiting_approval');
    const before = await first.service.listApprovals('run-1');
    expect(before).toHaveLength(1);

    // Fresh orchestrator/service instances over the same persisted state
    // (simulating a restarted worker), replaying the same run again with no
    // decision recorded yet: no duplicate ApprovalRequest, still parked.
    const second = makeHarness({}, stores, { gate: {} });
    await second.orchestrator.runProject('project-1', undefined, 'run-1');

    const after = await second.service.listApprovals('run-1');
    expect(after).toHaveLength(1);
    expect(after[0]?.request.id).toBe(before[0]?.request.id);
    expect((await second.runs.get('run-1'))?.status).toBe('awaiting_approval');
    expect(second.executor.started('review')).toBe(0);
  });

  it('recovers a crash between recording a decision and requeuing, without duplicating anything', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    // Simulate a crash right after the decision was durably recorded but
    // before the run was transitioned back to queued: write the decision
    // directly, bypassing decideApproval's own requeue step.
    await harness.approvalDecisions.create({
      id: 'decision-manual',
      requestId: request.id,
      runId: 'run-1',
      stepRunId: request.stepRunId,
      action: 'approve',
      decidedBy: 'ed',
      decidedAt: harness.clock.now().toISOString(),
    });
    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');

    // A retried (or first, from the caller's perspective) call recovers
    // instead of silently no-op'ing on the already-recorded decision.
    const recovered = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'someone-else',
    });
    expect(recovered.decision.id).toBe('decision-manual');
    expect(recovered.decision.decidedBy).toBe('ed');
    expect(recovered.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);

    // Once the run has moved on, a further repeat is a true no-op.
    const again = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'someone-else',
    });
    expect(again.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);
  });

  it('recovers request-changes after invalidation completes but the retry update crashes', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;
    let failQueuedUpdate = true;
    harness.runs.onBeforeUpdate = (candidate) => {
      if (failQueuedUpdate && candidate.status === 'queued') {
        failQueuedUpdate = false;
        throw new Error('simulated run update failure');
      }
    };

    await expect(
      harness.service.decideApproval('run-1', request.id, {
        action: 'request-changes',
        decidedBy: 'ed',
        note: 'add a regression test',
      }),
    ).rejects.toThrow('simulated run update failure');
    harness.runs.onBeforeUpdate = undefined;

    const [settled] = await harness.service.listApprovals('run-1');
    expect(settled!.decision).not.toBeNull();
    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');
    const invalidationReason = `approval-request-changes:${settled!.decision!.id}`;
    expect(harness.stepRuns.byStepId('run-1', 'implement')[0]).toMatchObject({
      invalidationReason,
    });

    const recovered = await harness.service.decideApproval('run-1', request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'add a regression test',
    });
    expect(recovered.run).toMatchObject({ status: 'queued', retry: { stepId: 'implement' } });
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.artifacts.named('repair-notes')).toHaveLength(1);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(harness.executor.started('implement')).toBe(2);
    expect(harness.artifacts.named('repair-notes')).toHaveLength(1);
    expect(harness.events.types().filter((type) => type === 'run.approval_decided')).toHaveLength(
      1,
    );
  });

  it('requeues a settled queued approval after the project requeue update crashes', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    let failProjectRequeue = true;
    harness.projects.onBeforeUpdate = (candidate) => {
      if (failProjectRequeue && candidate.status === 'queued') {
        failProjectRequeue = false;
        throw new Error('simulated project requeue failure');
      }
    };

    await expect(
      harness.service.decideApproval('run-1', entry!.request.id, {
        action: 'approve',
        decidedBy: 'ed',
      }),
    ).rejects.toThrow('simulated project requeue failure');
    harness.projects.onBeforeUpdate = undefined;
    expect((await harness.runs.get('run-1'))?.status).toBe('queued');
    expect((await harness.projects.get('project-1'))?.status).toBe('awaiting_approval');
    expect(harness.enqueued).toHaveLength(0);

    const recovered = await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    expect(recovered.run.status).toBe('queued');
    expect((await harness.projects.get('project-1'))?.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);

    await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    expect(harness.enqueued).toHaveLength(1);
    expect(await harness.service.listApprovals('run-1')).toHaveLength(1);
  });

  it('re-publishes one deterministic job when enqueue fails after the project is queued', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    harness.failNextEnqueue(new Error('simulated enqueue failure'));

    await expect(
      harness.service.decideApproval('run-1', entry!.request.id, {
        action: 'approve',
        decidedBy: 'ed',
      }),
    ).rejects.toThrow('simulated enqueue failure');
    expect((await harness.runs.get('run-1'))?.status).toBe('queued');
    expect((await harness.projects.get('project-1'))?.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(0);

    await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });

    const [settled] = await harness.service.listApprovals('run-1');
    expect(harness.enqueued).toEqual([
      expect.objectContaining({
        id: `run-project-run-1-approval-${settled!.decision!.id}`,
        runId: 'run-1',
      }),
    ]);
  });

  it('publishes distinct deterministic jobs for two approval decisions on one run', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [firstApproval] = await harness.service.listApprovals('run-1');
    const first = await harness.service.decideApproval('run-1', firstApproval!.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const approvals = await harness.service.listApprovals('run-1');
    const secondApproval = approvals.find((entry) => entry.decision === null)!;
    const second = await harness.service.decideApproval('run-1', secondApproval.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.service.decideApproval('run-1', secondApproval.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });

    expect(harness.enqueued.map((job) => job.id)).toEqual([
      `run-project-run-1-approval-${first.decision.id}`,
      `run-project-run-1-approval-${second.decision.id}`,
    ]);
  });

  it('rejects deciding an action the request does not allow', async () => {
    const harness = makeHarness({}, undefined, { gate: { actions: ['approve'] } });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    await expect(
      harness.service.decideApproval('run-1', request.id, { action: 'reject', decidedBy: 'ed' }),
    ).rejects.toThrow(/not allowed/);
  });

  it('conflicts (#14) when a differing decision arrives after the run already moved on', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    const first = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    expect(first.decision.action).toBe('approve');

    await expect(
      harness.service.decideApproval('run-1', request.id, { action: 'reject', decidedBy: 'sam' }),
    ).rejects.toMatchObject({
      name: 'ApprovalConflictError',
      decision: { action: 'approve', decidedBy: 'ed' },
    });

    // Repeating the same action that actually won is still an idempotent no-op.
    const repeat = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'someone-else',
    });
    expect(repeat.decision.decidedBy).toBe('ed');
  });

  it('conflicts (#14) a genuinely simultaneous pair of differing decisions: one wins, one 409s', async () => {
    const harness = makeHarness({}, undefined, { gate: {} });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [entry] = await harness.service.listApprovals('run-1');
    const { request } = entry!;

    const results = await Promise.allSettled([
      harness.service.decideApproval('run-1', request.id, { action: 'approve', decidedBy: 'ed' }),
      harness.service.decideApproval('run-1', request.id, { action: 'reject', decidedBy: 'sam' }),
    ]);
    const succeeded = results.filter(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<any>[];
    const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason.name).toBe('ApprovalConflictError');
    expect(failed[0]!.reason.decision).toEqual(succeeded[0]!.value.decision);
  });
});
