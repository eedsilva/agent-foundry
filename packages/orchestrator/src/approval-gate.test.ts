import { ApprovalDecisionSchema } from '@agent-foundry/contracts';
import { describe, expect, it } from 'vitest';
import { makeHarness, makeStores, seedRun } from './testing/harness.js';
import { WorkerLoop } from './worker-loop.js';

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

  it.each([
    ['auto-approve', 'approve', 'completed'],
    ['auto-reject', 'reject', 'rejected'],
  ] as const)('applies %s when its timeout expires', async (policy, action, status) => {
    let now = new Date('2026-07-14T12:00:00.000Z');
    const harness = makeHarness({}, makeStores({ now: () => now }), {
      gate: { timeout: { policy, afterMs: 60_000 } },
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    expect(harness.enqueued).toEqual([
      expect.objectContaining({
        type: 'run-project',
        id: `run-1:approval-timeout:${pending!.request.id}`,
        projectId: 'project-1',
        workflowId: harness.workflow.id,
        runId: 'run-1',
        attempts: 0,
        maxAttempts: 1,
        createdAt: '2026-07-14T12:00:00.000Z',
        availableAt: pending!.request.timeoutAt,
        leaseEpoch: 0,
      }),
    ]);

    now = new Date('2026-07-14T12:01:00.000Z');
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect((await harness.service.listApprovals('run-1'))[0]?.decision).toMatchObject({
      action,
      decidedBy: 'system:approval-timeout',
    });
    expect((await harness.runs.get('run-1'))?.status).toBe(status);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(await harness.service.listApprovals('run-1')).toHaveLength(1);
    expect(harness.enqueued).toHaveLength(1);
  });

  it('worker nacks and retries a failed delayed timeout enqueue', async () => {
    const harness = makeHarness({}, undefined, {
      gate: { timeout: { policy: 'auto-approve', afterMs: 60_000 } },
    });
    await harness.service.create({
      name: 'Timeout retry',
      prd: 'Create an approval gate.',
      workflowId: harness.workflow.id,
    });
    const [originalJob] = harness.enqueued;
    expect(originalJob).toMatchObject({ type: 'run-project', maxAttempts: 2 });
    harness.failNextEnqueue(new Error('queue unavailable'));
    harness.queueForWorker(originalJob!);
    const worker = new WorkerLoop(
      harness.queue,
      harness.orchestrator,
      {} as import('./conversation-operation-runner.js').ConversationOperationRunner,
      { workerId: 'worker-1', pollIntervalMs: 1_000 },
    );

    await worker.runOnce();
    expect((await harness.runs.get(originalJob!.runId!))?.status).toBe('awaiting_approval');
    expect(harness.nacked).toHaveLength(1);

    await worker.runOnce();
    const [pending] = await harness.service.listApprovals(originalJob!.runId!);
    expect(harness.enqueued).toContainEqual(
      expect.objectContaining({
        id: `${originalJob!.runId}:approval-timeout:${pending!.request.id}`,
        availableAt: pending!.request.timeoutAt,
      }),
    );
  });

  it('keeps the run awaiting approval when finite timeout scheduling retries exhaust', async () => {
    const harness = makeHarness({}, undefined, {
      gate: { timeout: { policy: 'auto-approve', afterMs: 60_000 } },
    });
    await harness.service.create({
      name: 'Timeout retry exhaustion',
      prd: 'Create an approval gate.',
      workflowId: harness.workflow.id,
    });
    const [originalJob] = harness.enqueued;
    harness.queueForWorker(originalJob!);
    const worker = new WorkerLoop(
      harness.queue,
      harness.orchestrator,
      {} as import('./conversation-operation-runner.js').ConversationOperationRunner,
      { workerId: 'worker-1', pollIntervalMs: 1_000 },
    );

    harness.failNextEnqueue(new Error('queue unavailable'));
    await worker.runOnce();
    harness.failNextEnqueue(new Error('queue unavailable'));
    await worker.runOnce();

    expect(await worker.runOnce()).toBe(false);
    expect(harness.nacked).toHaveLength(2);
    expect((await harness.runs.get(originalJob!.runId!))?.status).toBe('awaiting_approval');
  });

  it('does not enqueue an explicit no-timeout gate', async () => {
    const harness = makeHarness({}, undefined, { gate: { timeout: { policy: 'none' } } });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(harness.enqueued).toEqual([]);
  });

  it('ignores a stale timeout replay after a manual decision', async () => {
    let now = new Date('2026-07-14T12:00:00.000Z');
    const harness = makeHarness({}, makeStores({ now: () => now }), {
      gate: { timeout: { policy: 'auto-approve', afterMs: 60_000 } },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });

    now = new Date('2026-07-14T12:01:00.000Z');
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const [settled] = await harness.service.listApprovals('run-1');
    expect(settled?.decision).toMatchObject({ action: 'approve', decidedBy: 'ed' });
    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
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
    const rawActorId = 'ghp_abcdefghijklmnopqrst1234';
    const rawDisplayName = 'Cookie: session=actor-cookie; token=actor-token';
    const rawStructuredSecrets = [
      '{"access_token":"json-secret"}',
      'authorization="Bearer quoted-secret"',
      'Cookie=session=a; csrf=b',
    ].join('\n');
    const redactedNote = [
      'please add tests; Authorization: [REDACTED]',
      '{"access_token":"[REDACTED]"}',
      'authorization="[REDACTED]"',
      'Cookie=[REDACTED]',
    ].join('\n');

    const decided = await harness.service.decideApproval('run-1', request.id, {
      action: 'request-changes',
      actor: { kind: 'user', id: rawActorId, displayName: rawDisplayName },
      note: `please add tests; Authorization: Bearer abcdef1234567890ABCDEF\n${rawStructuredSecrets}`,
    });
    expect(decided.decision).toMatchObject({
      decidedBy: 'Cookie: [REDACTED]',
      actor: { kind: 'user', id: '[REDACTED]', displayName: 'Cookie: [REDACTED]' },
      note: redactedNote,
    });
    expect(ApprovalDecisionSchema.parse(decided.decision)).toEqual(decided.decision);
    expect(await harness.approvalDecisions.get('run-1', request.id)).toEqual(decided.decision);
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
      note: redactedNote,
      actor: { kind: 'user', id: '[REDACTED]', displayName: 'Cookie: [REDACTED]' },
      sourceRequestId: request.id,
      sourceDecisionId: decided.decision.id,
      runId: 'run-1',
      stepRunId: request.stepRunId,
    });
    expect(feedback.metadata).toMatchObject({
      kind: 'feedback',
      actor: { kind: 'user', id: '[REDACTED]', displayName: 'Cookie: [REDACTED]' },
      sourceDecisionId: decided.decision.id,
    });
    expect(
      harness.events.events.find((event) => event.type === 'run.approval_decided')?.data,
    ).toMatchObject({ decidedBy: 'Cookie: [REDACTED]' });
    expect(
      (await harness.service.exportRunAudit('run-1')).entries.find(
        (entry) => entry.kind === 'approval-decision',
      ),
    ).toMatchObject({
      decision: {
        decidedBy: 'Cookie: [REDACTED]',
        actor: { id: '[REDACTED]', displayName: 'Cookie: [REDACTED]' },
      },
    });
    expect(JSON.stringify({ decision: decided.decision, feedback })).not.toContain(rawActorId);
    expect(JSON.stringify({ decision: decided.decision, feedback })).not.toContain('actor-cookie');
    expect(JSON.stringify({ decision: decided.decision, feedback })).not.toMatch(
      /json-secret|quoted-secret|csrf=b/,
    );
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

  it('deduplicates an exact feedback reference already loaded from YAML', async () => {
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
    await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'repair it',
    });
    const feedbackReference = (await harness.runs.get('run-1'))!.retry!.feedbackArtifact!;
    const implementNode = harness.workflow.nodes.find((node) => node.id === 'implement')!;
    if (implementNode.type !== 'agent') throw new Error('expected implement agent');
    implementNode.inputArtifacts = ['repair-notes'];

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const activeImplement = harness.stepRuns
      .byStepId('run-1', 'implement')
      .find((step) => !step.invalidatedAt)!;
    const [attempt] = await harness.stepAttempts.list('run-1', activeImplement.id);
    expect(attempt?.inputArtifacts).toEqual([feedbackReference]);
    const requestMarkdown = (
      harness.artifacts.named(`run-${attempt!.id}`)[0]!.content as { requestMarkdown: string }
    ).requestMarkdown;
    expect(
      requestMarkdown.split(`### repair-notes · revision ${feedbackReference.revision}`),
    ).toHaveLength(2);
  });

  it('keeps a same-name YAML input when its revision differs from retry feedback', async () => {
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
    await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'first revision',
    });
    const feedbackReference = (await harness.runs.get('run-1'))!.retry!.feedbackArtifact!;
    const latest = await harness.artifacts.put({
      projectId: 'project-1',
      name: 'repair-notes',
      content: { schemaVersion: '1', note: 'newer YAML input' },
      createdBy: 'test',
    });
    const latestReference = {
      name: latest.metadata.name,
      revision: latest.metadata.revision,
      sha256: latest.metadata.sha256,
    };
    const implementNode = harness.workflow.nodes.find((node) => node.id === 'implement')!;
    if (implementNode.type !== 'agent') throw new Error('expected implement agent');
    implementNode.inputArtifacts = ['repair-notes'];

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const activeImplement = harness.stepRuns
      .byStepId('run-1', 'implement')
      .find((step) => !step.invalidatedAt)!;
    const [attempt] = await harness.stepAttempts.list('run-1', activeImplement.id);
    expect(attempt?.inputArtifacts).toEqual([latestReference, feedbackReference]);
    const requestMarkdown = (
      harness.artifacts.named(`run-${attempt!.id}`)[0]!.content as { requestMarkdown: string }
    ).requestMarkdown;
    expect(requestMarkdown).toContain(`### repair-notes · revision ${latestReference.revision}`);
    expect(requestMarkdown).toContain(`### repair-notes · revision ${feedbackReference.revision}`);
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
    const rawLegacyIdentity = 'Authorization: Bearer legacyidentity1234567890';
    await harness.approvalDecisions.create({
      id: 'decision-manual',
      requestId: request.id,
      runId: 'run-1',
      stepRunId: request.stepRunId,
      action: 'approve',
      decidedBy: rawLegacyIdentity,
      note: 'Authorization: Bearer abcdef1234567890\nCookie: session=raw-secret; token=also-raw',
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
    expect(recovered.decision.decidedBy).toBe('Authorization: [REDACTED]');
    expect(recovered.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);

    // Once the run has moved on, a further repeat is a true no-op.
    const again = await harness.service.decideApproval('run-1', request.id, {
      action: 'approve',
      decidedBy: 'someone-else',
    });
    expect(again.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const approvalArtifact = harness.artifacts.named('gate-decision')[0]!;
    expect(approvalArtifact.content).toMatchObject({
      decision: {
        decidedBy: 'Authorization: [REDACTED]',
        actor: { kind: 'user', id: 'Authorization: [REDACTED]' },
        note: 'Authorization: [REDACTED]\nCookie: [REDACTED]',
      },
    });
    expect(
      ApprovalDecisionSchema.parse((approvalArtifact.content as { decision: unknown }).decision)
        .actor,
    ).toEqual({ kind: 'user', id: 'Authorization: [REDACTED]' });
    expect(JSON.stringify(approvalArtifact.content)).not.toContain(rawLegacyIdentity);
    expect(JSON.stringify(approvalArtifact.content)).not.toContain('raw-secret');
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

  it('does not replay an old decision across a newer pending approval', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [originalFirstApproval] = await harness.service.listApprovals('run-1');
    const firstApproval = {
      ...originalFirstApproval!,
      request: { ...originalFirstApproval!.request, id: 'z-first-request' },
    };
    harness.approvalRequests.store.delete(`run-1/${originalFirstApproval!.request.id}`);
    harness.approvalRequests.store.set('run-1/z-first-request', firstApproval.request);
    const first = await harness.service.decideApproval('run-1', firstApproval.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const originalPendingRequest = (await harness.service.listApprovals('run-1')).find(
      (entry) => entry.decision === null,
    )!.request;
    const pendingRequest = {
      ...originalPendingRequest,
      createdAt: firstApproval.request.createdAt,
    };
    harness.approvalRequests.store.set(`run-1/${pendingRequest.id}`, pendingRequest);

    const snapshot = async () => ({
      run: await harness.runs.get('run-1'),
      approvals: await harness.service.listApprovals('run-1'),
      steps: await harness.stepRuns.list('run-1'),
      jobs: [...harness.enqueued],
      events: [...harness.events.events],
    });
    const before = await snapshot();
    expect(before.run?.status).toBe('awaiting_approval');
    expect(before.approvals.some((entry) => entry.decision === null)).toBe(true);
    expect(pendingRequest.createdAt).toBe(firstApproval.request.createdAt);
    expect(pendingRequest.id.localeCompare(firstApproval.request.id)).toBeLessThan(0);

    const replay = await harness.service.decideApproval('run-1', firstApproval.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });

    expect(replay.decision.id).toBe(first.decision.id);
    expect(await snapshot()).toEqual(before);

    const secondRequest = pendingRequest;
    await harness.approvalDecisions.create({
      id: 'decision-second',
      requestId: secondRequest.id,
      runId: 'run-1',
      stepRunId: secondRequest.stepRunId,
      action: 'approve',
      decidedBy: 'reviewer',
      decidedAt: harness.clock.now().toISOString(),
    });
    const afterSecondDecision = await snapshot();

    await harness.service.decideApproval('run-1', firstApproval.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });

    expect(await snapshot()).toEqual(afterSecondDecision);
  });

  it('does not republish an old decision after a newer approval is queued', async () => {
    const harness = makeHarness({}, undefined, {
      gate: {
        actions: ['approve', 'request-changes'],
        returnToStepId: 'implement',
        repairArtifact: 'repair-notes',
      },
    });
    await seedRun(harness);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [originalFirstApproval] = await harness.service.listApprovals('run-1');
    const firstRequest = { ...originalFirstApproval!.request, id: 'z-first-request' };
    harness.approvalRequests.store.delete(`run-1/${originalFirstApproval!.request.id}`);
    harness.approvalRequests.store.set('run-1/z-first-request', firstRequest);
    await harness.service.decideApproval('run-1', firstRequest.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    harness.enqueued.length = 0;

    const approvals = await harness.service.listApprovals('run-1');
    const secondApproval = approvals.find((entry) => entry.decision === null)!;
    const secondRequest = {
      ...secondApproval.request,
      createdAt: firstRequest.createdAt,
    };
    harness.approvalRequests.store.set(`run-1/${secondRequest.id}`, secondRequest);
    expect(secondRequest.createdAt).toBe(firstRequest.createdAt);
    expect(secondRequest.id.localeCompare(firstRequest.id)).toBeLessThan(0);
    const second = await harness.service.decideApproval('run-1', secondRequest.id, {
      action: 'approve',
      decidedBy: 'reviewer',
    });
    const queuedJobIds = harness.enqueued.map((job) => job.id);

    await harness.service.decideApproval('run-1', firstRequest.id, {
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'revise it',
    });

    expect(harness.enqueued.map((job) => job.id)).toEqual(queuedJobIds);
    expect(queuedJobIds).toEqual([`run-project-run-1-approval-${second.decision.id}`]);
  });

  it('normalizes and redacts legacy decisions at every service read boundary', async () => {
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
    const rawNote =
      'Authorization: Bearer abcdef1234567890\nCookie: session=raw-secret; token=also-raw';
    await harness.approvalDecisions.create({
      id: 'legacy-decision',
      requestId: entry!.request.id,
      runId: 'run-1',
      stepRunId: entry!.request.stepRunId,
      action: 'request-changes',
      decidedBy: 'legacy-reviewer',
      note: rawNote,
      decidedAt: harness.clock.now().toISOString(),
    });

    const recovered = await harness.service.decideApproval('run-1', entry!.request.id, {
      action: 'request-changes',
      decidedBy: 'legacy-reviewer',
      note: 'ignored retry input',
    });

    expect(harness.artifacts.named('repair-notes')[0]?.content).toMatchObject({
      note: 'Authorization: [REDACTED]\nCookie: [REDACTED]',
    });
    expect(recovered.decision).toMatchObject({
      actor: { kind: 'user', id: 'legacy-reviewer' },
      note: 'Authorization: [REDACTED]\nCookie: [REDACTED]',
    });
    expect((await harness.service.listApprovals('run-1'))[0]?.decision).toMatchObject(
      recovered.decision,
    );
    expect(
      (await harness.service.exportRunAudit('run-1')).entries.find(
        (auditEntry) => auditEntry.kind === 'approval-decision',
      ),
    ).toMatchObject({ decision: recovered.decision });
    expect(
      (
        await harness.service.decideApproval('run-1', entry!.request.id, {
          action: 'request-changes',
          decidedBy: 'legacy-reviewer',
          note: 'ignored retry input',
        })
      ).decision,
    ).toEqual(recovered.decision);
    const persisted = await harness.approvalDecisions.get('run-1', entry!.request.id);
    expect(persisted?.actor).toBeUndefined();
    expect(persisted?.note).toBe(rawNote);
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
