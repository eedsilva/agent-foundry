import { resolve } from 'node:path';
import {
  loadTracerScenarios,
  runTracerScenario,
  runTracerScenarioToCompletion,
} from '../packages/composition/src/tracer.js';
import { argValue as sharedArgValue, assertRealModeReady } from './lib/cli-shared.js';

// Anchor to the repo root (this script lives at <root>/scripts/tracer.ts) so
// the CLI resolves scenarios regardless of the invoking cwd.
const rootDir = resolve(import.meta.dirname, '..');
const scenariosDir = resolve(rootDir, 'examples/tracer/scenarios');
const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  return sharedArgValue(args, flag);
}

const executorMode = argValue('--executor-mode') === 'mock' ? ('mock' as const) : ('real' as const);
// #509: a bare runOnce() parks at the plan-approval gate. --approve-gates
// drives the run past every operator-approval gate to a terminal status —
// needed to reach browser verification (e.g. for UI-quality-judge evidence).
// --policies-dir/--policy-id opt the run into a non-default ProjectPolicy
// field (e.g. uiQualityJudge), same as projectService.create's own policyId.
const approveGates = args.includes('--approve-gates');
const policiesDir = argValue('--policies-dir');
const policyId = argValue('--policy-id');
// Pins DATA_DIR instead of the default throwaway mkdtemp, so evidence
// (artifacts, screenshots) can be pulled from a known path after the run.
const dataDir = argValue('--data-dir');

try {
  const scenarioId = argValue('--scenario');
  if (!scenarioId && !args.includes('--all')) {
    console.error(
      'Usage: tsx scripts/tracer.ts --scenario <id> | --all ' +
        '[--executor-mode mock] [--approve-gates] [--policies-dir <dir>] [--policy-id <id>] [--data-dir <dir>]',
    );
    process.exit(1);
  }
  if (executorMode === 'real') {
    await assertRealModeReady({
      envVarName: 'RUN_REAL_TRACER',
      rootDir,
      requireValidationCampaign: true,
    });
  }

  const scenarios = await loadTracerScenarios(scenariosDir);
  const selected = scenarioId
    ? scenarios.filter((scenario) => scenario.id === scenarioId)
    : scenarios;
  if (selected.length === 0) {
    console.error(scenarioId ? `Unknown scenario: ${scenarioId}` : 'No tracer scenarios found.');
    process.exit(1);
  }

  const runScenario = approveGates ? runTracerScenarioToCompletion : runTracerScenario;
  for (const scenario of selected) {
    const result = await runScenario(scenario, {
      executorMode,
      ...(policiesDir ? { policiesDir } : {}),
      ...(policyId ? { policyId } : {}),
      ...(dataDir ? { dataDir } : {}),
    });
    console.log(
      `${scenario.id}: project ${result.projectId}, run ${result.runId} → ${result.runStatus}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Tracer runner failed.');
  process.exitCode = 1;
}
