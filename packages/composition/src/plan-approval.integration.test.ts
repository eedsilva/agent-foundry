import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from './runtime.js';

// Issue #297's "Status App" PRD, kept verbatim in spirit: the non-goals
// explicitly exclude auth. Under the old `plan-gate` quality loop a
// plan-reviewer invented an access-control requirement (NFR-09), rejected four
// plans in 23 minutes, and was still looping past `maxIterations: 3` when the
// run was killed. ADR 0042 deleted that reviewer; this file is what stops it
// coming back.
const STATUS_APP_PRD = [
  '# Status App',
  '',
  '## Goal',
  'A single-user kanban board with three fixed columns: todo, in progress, done.',
  'Cards can be created, moved between columns, and deleted. State persists across reloads.',
  '',
  '## Non-goals',
  '- No authentication. There is no sign-in, no session, and no user record.',
  '- No multi-user support. One person uses one board.',
  '- No deployment or container publishing concerns.',
].join('\n');

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function startStatusAppRun(workerId: string): Promise<{
  runtime: Runtime;
  projectId: string;
  runId: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-plan-approval-'));
  temporaryDirectories.push(dataDir);
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: workerId,
  });
  const project = await runtime.projectService.create({
    name: 'Status App',
    workflowId: 'web-app-v1',
    prd: STATUS_APP_PRD,
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  expect(await runtime.worker.runOnce()).toBe(true);
  return { runtime, projectId: project.id, runId: project.currentRunId };
}

describe('#297: a minimal no-auth PRD reaches operator approval without a repair loop', () => {
  it('parks on plan.current revision 1 after exactly one model call', async () => {
    const { runtime, projectId, runId } = await startStatusAppRun('plan-approval-worker');

    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('awaiting_approval');

    // The whole pipeline before the operator: one agent step, one gate.
    const stepRuns = await runtime.stepRuns.list(runId);
    expect(stepRuns.map((step) => step.stepId)).toEqual(['plan', 'plan-approval']);

    const attempts = (
      await Promise.all(stepRuns.map((step) => runtime.stepAttempts.list(runId, step.id)))
    ).flat();
    expect(attempts.filter((attempt) => attempt.executorKind === 'agent')).toHaveLength(1);

    const approvals = await runtime.projectService.listApprovals(runId);
    expect(approvals).toHaveLength(1);
    const [pending] = approvals;
    expect(pending!.decision).toBeNull();
    expect(pending!.request.nodeId).toBe('plan-approval');
    expect(pending!.request.allowedActions).toEqual(['approve', 'reject']);
    // Revision 1: nothing repaired the plan on its way to the operator.
    expect(pending!.request.artifact).toMatchObject({ name: 'plan.current', revision: 1 });
  }, 30_000);

  it('approve advances the run past the gate', async () => {
    const { runtime, runId } = await startStatusAppRun('plan-approval-approve-worker');

    async function approveNextGate(expectedNodeId: string): Promise<void> {
      const pending = (await runtime.projectService.listApprovals(runId)).find(
        (entry) => !entry.decision,
      );
      expect(pending?.request.nodeId).toBe(expectedNodeId);
      const { run } = await runtime.projectService.decideApproval(runId, pending!.request.id, {
        action: 'approve',
        decidedBy: 'ed',
      });
      expect(run.status).toBe('queued');
      expect(await runtime.worker.runOnce()).toBe(true);
    }

    // Approving the plan runs the schema step and parks on its own gate (#481);
    // approving that one is what actually enters the task loop, where the
    // implement step runs once per planned task under `implement.<taskId>`.
    await approveNextGate('plan-approval');
    await approveNextGate('schema-approval');

    const stepIds = (await runtime.stepRuns.list(runId)).map((step) => step.stepId);
    expect(stepIds.some((stepId) => stepId.startsWith('implement.'))).toBe(true);
    // Two gates and three agent steps of real mock-mode work; 30s was enough
    // for one gate but times out under whole-suite CPU contention.
  }, 60_000);

  it('reject ends the run with the operator reason recorded', async () => {
    const { runtime, projectId, runId } = await startStatusAppRun('plan-approval-reject-worker');
    const [pending] = await runtime.projectService.listApprovals(runId);
    const reason = 'Milestone 2 belongs in a later version.';

    await runtime.projectService.decideApproval(runId, pending!.request.id, {
      action: 'reject',
      decidedBy: 'ed',
      note: reason,
    });
    expect(await runtime.worker.runOnce()).toBe(true);

    expect(await runtime.runs.get(runId)).toMatchObject({ status: 'rejected' });
    const detail = await runtime.projectService.get(projectId);
    expect(detail.project.status).toBe('rejected');
    const rejection = detail.events.find((event) => event.type === 'run.rejected');
    expect(rejection?.message).toContain(reason);
    expect(rejection?.data).toMatchObject({ reason });
    // The decision itself keeps the reason too, for anyone reading approvals.
    const [decided] = await runtime.projectService.listApprovals(runId);
    expect(decided!.decision).toMatchObject({ action: 'reject', note: reason });
  }, 30_000);
});
