import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { StepAttempt, StepRun, WorkflowRun } from '@agent-foundry/contracts';
import type { Runtime } from './runtime.js';

export const VALID_STANDARD_PRD = `# PRD — Test application
PRD Standard: 1
Interface language: en-US

## 1. Problem and objective / Problema e objetivo

Let an authenticated owner manage tasks.

## 2. Users and roles / Usuários e papéis

- Owner: manages only their tasks.

## 3. Scope and non-goals / Escopo e não objetivos

Task management; collaboration is excluded.

## 4. Primary journeys / Jornadas principais

1. Owner creates and completes a task.

## 5. Screens and states / Telas e estados

Task list with loading, empty, error, and success states.

## 6. Functional requirements / Requisitos funcionais

- **FR-001**: The owner can create a task. \`capability:user-owned-crud\`

## 7. Conceptual data and ownership / Dados conceituais e propriedade

A task belongs to one owner.

## 8. Business rules / Regras de negócio

- **BR-001**: Owners access only their tasks. \`capability:ownership\`

## 9. Authentication and permissions / Autenticação e permissões

Authentication is required; cross-user access is denied.

## 10. Non-functional requirements / Requisitos não funcionais

- **NFR-001**: The task list is keyboard accessible. \`capability:interface-language\`

## 11. Acceptance criteria / Critérios de aceite

- **AC-001** — Verifies: FR-001, BR-001, NFR-001
  - Given an authenticated owner
  - When the owner creates a task
  - Then the task appears only in that owner's list.

## 12. Assumptions / Premissas

None

## 13. Open decisions / Decisões em aberto

None`;

// Not exported from index.ts: this is test-only wiring, and re-exporting it through
// the package barrel would put it on every consumer's public surface. Shared here
// (rather than one test file importing from another) because importing a *.test.ts
// module re-evaluates its top-level describe/it calls under the importing file's
// test run, double-registering the suite -- see runtime.postgres.test.ts /
// runtime.integration.test.ts, which both need this and previously kept
// byte-identical copies.
/**
 * Drives a mock `web-app-v1` run to completion through every operator gate it
 * parks at. Kept here rather than in each suite because the gate list is a
 * property of the workflow, not of any one test.
 */
export async function approveAllGates(
  runtime: Runtime,
  runId: string,
  decidedBy = 'integration-test',
): Promise<void> {
  for (;;) {
    const pending = (await runtime.projectService.listApprovals(runId)).find(
      (entry) => !entry.decision,
    );
    if (!pending) return;
    await runtime.projectService.decideApproval(runId, pending.request.id, {
      action: 'approve',
      decidedBy,
    });
    if (!(await runtime.worker.runOnce())) return;
  }
}

export const MINI_PACKAGE = `${JSON.stringify({ name: 'mini', private: true, version: '0.0.0' }, null, 2)}\n`;

// Shared by dogfood.test.ts and benchmark-runner.test.ts: both build a
// throwaway git repo with two commits (a baseline + a later commit, since real
// dogfood/benchmark baselineRefs point at non-tip SHAs) to seed runDogfoodTask
// / runBenchmarkCase from.
export async function seedFixtureRepo(
  path: string,
  files: Record<string, string>,
  identity: { name: string; email: string } = {
    name: 'Test Fixture',
    email: 'test-fixture@example.invalid',
  },
): Promise<{ path: string; sha: string }> {
  for (const [relative, content] of Object.entries(files)) {
    const destination = join(path, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await execa('git', ['init', '--quiet'], { cwd: path });
  await execa('git', ['config', 'user.name', identity.name], { cwd: path });
  await execa('git', ['config', 'user.email', identity.email], { cwd: path });
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: path });
  // Real tasks reference short SHAs of non-tip commits (e.g. 8896a3c), so the
  // fixture baseline must not be a branch tip either.
  const short = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: path });
  await writeFile(join(path, 'EXTRA.txt'), 'later commit\n');
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'later commit'], { cwd: path });
  return { path, sha: short.stdout.trim() };
}

/** Shared Docker guard for e2e/integration suites (promoted at the third
 * caller, per the ponytail note that used to live in runtime.postgres.test.ts). */
export function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Human-readable reason a run did not reach its expected status (#658).
 *
 * A nightly gate that fails with `'failed' !== 'completed'` and nothing else is
 * untriageable without reproducing the whole journey locally, which is why the
 * pipeline regression sat red for 18 nights. Pass this as the assertion message
 * so the first step attempt that did not succeed — its step and its error —
 * lands in the CI log next to the failure. Pure on purpose: it formats state the
 * caller already loaded, so it costs nothing on the passing path.
 */
export function describeRunFailure(
  run: WorkflowRun | null,
  steps: StepRun[],
  attempts: StepAttempt[],
): string {
  const lines = [`run status=${run?.status ?? 'missing'}`];
  if (run?.error) lines.push(`run error: ${run.error.name}: ${run.error.message}`);
  const stepsById = new Map(steps.map((step) => [step.id, step]));
  const attempt = attempts.find((candidate) => candidate.status !== 'succeeded');
  if (attempt) {
    const step = stepsById.get(attempt.stepRunId);
    lines.push(
      `first non-succeeded attempt: step ${attempt.context.nodeId}/${attempt.context.stepId}` +
        (step ? ` (${step.stepType}, step status=${step.status})` : '') +
        ` attempt ${attempt.id} status=${attempt.status}` +
        (attempt.error
          ? `\nattempt error: ${attempt.error.name}: ${attempt.error.message}` +
            (attempt.error.exitCode === undefined ? '' : ` (exit ${attempt.error.exitCode})`)
          : ' (no error recorded)'),
    );
    return lines.join('\n');
  }
  const failedStep = steps.find((step) => step.status === 'failed' || step.status === 'cancelled');
  if (failedStep) {
    lines.push(
      `no attempt failed; first ${failedStep.status} step: ${failedStep.nodeId}/${failedStep.stepId}` +
        (failedStep.error ? ` error: ${failedStep.error.name}: ${failedStep.error.message}` : ''),
    );
    return lines.join('\n');
  }
  lines.push(
    `no failed step or attempt — steps: ${steps.map((step) => `${step.nodeId}/${step.stepId}=${step.status}`).join(', ') || '(none)'}`,
  );
  return lines.join('\n');
}
