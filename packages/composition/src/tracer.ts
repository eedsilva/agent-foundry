import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TracerScenarioSchema, type Project, type TracerScenario } from '@agent-foundry/contracts';
import { loadJsonDirectory } from './dogfood.js';
import { createRuntime, type Runtime } from './runtime.js';

// The monorepo root that owns the workflows the tracer runs against —
// independent of DATA_DIR, which is always a throwaway per-run directory.
const FOUNDRY_ROOT = resolve(import.meta.dirname, '../../..');

export async function loadTracerScenarios(dir: string): Promise<TracerScenario[]> {
  return loadJsonDirectory(dir, TracerScenarioSchema);
}

export interface RunTracerScenarioOptions {
  dataDir?: string;
  executorMode?: 'real' | 'mock';
  /** Overrides the policies directory (default: `<REPO_ROOT>/policies`) — needed to opt a run into a non-default `ProjectPolicy` field, e.g. `uiQualityJudge` (#509). */
  policiesDir?: string;
  /** `ProjectPolicy` id to run under; defaults to `'default'` same as `projectService.create`. */
  policyId?: string;
}

export interface TracerScenarioRunResult {
  projectId: string;
  runId: string;
  runStatus: string;
}

async function startTracerRun(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions,
): Promise<{ runtime: Runtime; project: Project; runId: string }> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), `tracer-${scenario.id}-`)));
  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: FOUNDRY_ROOT,
    // WORKFLOWS_DIR is left to its default (resolved against REPO_ROOT):
    // unlike runDogfoodTask, REPO_ROOT here already is the monorepo root that
    // owns workflows/, not a separate seed checkout.
    DATA_DIR: dataDir,
    EXECUTOR_MODE: options.executorMode ?? 'real',
    // Pinned rather than left to ambient env, same as runDogfoodTask: an
    // inherited RUN_WORKER_INLINE=true (e.g. a leftover `dev:inline` shell)
    // would start a background auto-loop that races the explicit
    // runOnce() call below.
    RUN_WORKER_INLINE: 'false',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: `tracer-${scenario.id}`,
    ...(options.policiesDir ? { POLICIES_DIR: options.policiesDir } : {}),
  });

  const project = await runtime.projectService.create({
    name: scenario.id,
    prd: scenario.prompt,
    workflowId: scenario.workflowId,
    ...(options.policyId ? { policyId: options.policyId } : {}),
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');
  return { runtime, project, runId: project.currentRunId };
}

// Deliberately minimal: create a project from the scenario's prompt and drive
// the run one step. This proves the *input* mechanism (a scenario file needs
// no runner code changes to add a new app shape) — it does not replicate
// runDogfoodTask's report/baseline/verification pipeline, which is out of
// scope for #474 (no new harness stages).
export async function runTracerScenario(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions = {},
): Promise<TracerScenarioRunResult> {
  const { runtime, project, runId } = await startTracerRun(scenario, options);

  await runtime.worker.runOnce();
  const run = await runtime.runs.get(runId);

  return { projectId: project.id, runId, runStatus: run?.status ?? 'unknown' };
}

// #509: a single runOnce() only proves the plan step runs — it parks at the
// plan-approval gate. Producing UI-quality-judge evidence needs a run that
// actually reaches browser verification, on the far side of that gate. This
// auto-approves every operator-approval gate the run parks at until the
// workflow reaches a terminal status. Mirrors testing-helpers.ts's
// approveAllGates but kept separate: that helper is deliberately not part of
// the composition package's public surface (see its own comment) because
// it's test-only wiring; this is the production code path scripts/tracer.ts
// runs in real mode.
export async function runTracerScenarioToCompletion(
  scenario: TracerScenario,
  options: RunTracerScenarioOptions = {},
): Promise<TracerScenarioRunResult> {
  const { runtime, project, runId } = await startTracerRun(scenario, options);

  await runtime.worker.runOnce();
  for (;;) {
    const pending = (await runtime.projectService.listApprovals(runId)).find(
      (entry) => !entry.decision,
    );
    if (!pending) break;
    await runtime.projectService.decideApproval(runId, pending.request.id, {
      action: 'approve',
      decidedBy: 'tracer-driver',
    });
    if (!(await runtime.worker.runOnce())) break;
  }
  const run = await runtime.runs.get(runId);

  return { projectId: project.id, runId, runStatus: run?.status ?? 'unknown' };
}
