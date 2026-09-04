import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, type Runtime } from './runtime.js';
import { approveCurrentPrd } from './prd-approval.js';
// Issue #297's Status App remains explicitly single-user and no-auth. #643 only
// reformats that product contract; it must not let a reviewer invent access
// control while making the fixture pass Standard PRD 1.
const STATUS_APP_PRD = `# PRD — Status App
PRD Standard: 1
Interface language: en-US

## 1. Problem and objective / Problema e objetivo

A single user needs a kanban board whose card state persists across reloads.

## 2. Users and roles / Usuários e papéis

- Single user: creates, moves, and deletes cards without an account.

## 3. Scope and non-goals / Escopo e não objetivos

A board with fixed todo, in progress, and done columns is in scope. Authentication, multi-user support, deployment, and container publishing are excluded.

## 4. Primary journeys / Jornadas principais

1. The user creates a card, moves it between columns, reloads, and sees the same state.

## 5. Screens and states / Telas e estados

The board shows three fixed columns, card actions, and loading, empty, error, and success states.

## 6. Functional requirements / Requisitos funcionais

- **FR-001**: The user can create, move, and delete cards. \`capability:user-owned-crud\`
- **FR-002**: Card state persists across reloads. \`capability:user-owned-crud\`

## 7. Conceptual data and ownership / Dados conceituais e propriedade

One board contains cards, and each card belongs to exactly one of the three fixed columns.

## 8. Business rules / Regras de negócio

- **BR-001**: Every card is in exactly one fixed column. \`capability:ownership\`

## 9. Authentication and permissions / Autenticação e permissões

No authentication is required; there is no sign-in, session, user record, or multi-user access boundary.

## 10. Non-functional requirements / Requisitos não funcionais

- **NFR-001**: Card creation, movement, and deletion are keyboard accessible. \`capability:interface-language\`

## 11. Acceptance criteria / Critérios de aceite

- **AC-001** — Verifies: FR-001, FR-002, BR-001, NFR-001
  - Given one person uses the board without signing in
  - When they create and move a card and reload the page
  - Then the accessible board restores the card in its last column.

## 12. Assumptions / Premissas

None

## 13. Open decisions / Decisões em aberto

None`;

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
  const projectDirectory = await mkdtemp(join(tmpdir(), 'agent-foundry-plan-approval-project-'));
  temporaryDirectories.push(dataDir, projectDirectory);
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
    projectDirectory,
  });
  await approveCurrentPrd(runtime, project.id);
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  expect(await runtime.worker.runOnce()).toBe(true);
  return { runtime, projectId: project.id, runId: project.currentRunId };
}

describe('#297: a minimal no-auth PRD reaches operator approval without a repair loop', () => {
  it('parks on plan.current revision 1 after exactly one model call', async () => {
    expect(STATUS_APP_PRD).toContain('No authentication is required');
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
