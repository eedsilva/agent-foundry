import { resolve } from 'node:path';
import { loadTracerScenarios, runTracerScenario } from '../packages/composition/src/tracer.js';
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

try {
  const scenarioId = argValue('--scenario');
  if (!scenarioId && !args.includes('--all')) {
    console.error('Usage: tsx scripts/tracer.ts --scenario <id> | --all [--executor-mode mock]');
    process.exit(1);
  }
  if (executorMode === 'real') {
    await assertRealModeReady({ envVarName: 'RUN_REAL_TRACER', rootDir });
  }

  const scenarios = await loadTracerScenarios(scenariosDir);
  const selected = scenarioId
    ? scenarios.filter((scenario) => scenario.id === scenarioId)
    : scenarios;
  if (selected.length === 0) {
    console.error(scenarioId ? `Unknown scenario: ${scenarioId}` : 'No tracer scenarios found.');
    process.exit(1);
  }

  for (const scenario of selected) {
    const result = await runTracerScenario(scenario, { executorMode });
    console.log(
      `${scenario.id}: project ${result.projectId}, run ${result.runId} → ${result.runStatus}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Tracer runner failed.');
  process.exitCode = 1;
}
