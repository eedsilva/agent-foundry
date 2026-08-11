import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TracerScenarioSchema, type TracerScenario } from '@agent-foundry/contracts';
import { loadJsonDirectory } from './dogfood.js';
import { createRuntime } from './runtime.js';

// The monorepo root that owns the workflows the tracer runs against —
// independent of DATA_DIR, which is always a throwaway per-run directory.
const FOUNDRY_ROOT = resolve(import.meta.dirname, '../../..');

export async function loadTracerScenarios(dir: string): Promise<TracerScenario[]> {
  return loadJsonDirectory(dir, TracerScenarioSchema);
}

export interface RunTracerScenarioOptions {
  dataDir?: string;
  executorMode?: 'real' | 'mock';
}

export interface TracerScenarioRunResult {
  projectId: string;
  runId: string;
  runStatus: string;
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
  });

  const project = await runtime.projectService.create({
    name: scenario.id,
    prd: scenario.prompt,
    workflowId: scenario.workflowId,
  });
  if (!project.currentRunId) throw new Error('Expected project to reference its workflow run');

  await runtime.worker.runOnce();
  const run = await runtime.runs.get(project.currentRunId);

  return {
    projectId: project.id,
    runId: project.currentRunId,
    runStatus: run?.status ?? 'unknown',
  };
}
