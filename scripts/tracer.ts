import { resolve } from 'node:path';
import {
  evaluateGoldenJourneyGate,
  goldenJourneyVerdictWithoutEvidence,
  writeGoldenJourneyEvidence,
  type GoldenJourneyEvidenceEntry,
} from '../packages/composition/src/golden-journey-gate.js';
import {
  loadTracerScenarios,
  runTracerScenario,
  runTracerScenarioToCompletion,
  TracerScenarioError,
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
// #564: --evidence-dir writes each run's published bundle plus one 4/4 summary,
// so the release gate stops being four artifact trees read by hand. --gate is
// opt-in rather than implied by --all because --all is also the mock-mode smoke
// test of the scenario loop, which publishes no bundle and would always fail.
const evidenceDir = argValue('--evidence-dir');
const gate = args.includes('--gate');

try {
  const scenarioId = argValue('--scenario');
  if (!scenarioId && !args.includes('--all')) {
    console.error(
      'Usage: tsx scripts/tracer.ts --scenario <id> | --all ' +
        '[--executor-mode mock] [--approve-gates] [--policies-dir <dir>] [--policy-id <id>] ' +
        '[--data-dir <dir>] [--evidence-dir <dir>] [--gate]',
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
  const entries: GoldenJourneyEvidenceEntry[] = [];
  for (const scenario of selected) {
    // A scenario that throws is one red shape, not the end of the sweep: four
    // shapes cost hours of wall clock, and three defects found in one sitting
    // beat one. The throw becomes this scenario's verdict and the loop moves on.
    try {
      const result = await runScenario(scenario, {
        executorMode,
        ...(policiesDir ? { policiesDir } : {}),
        ...(policyId ? { policyId } : {}),
        ...(dataDir ? { dataDir } : {}),
      });
      const verdict = evaluateGoldenJourneyGate({
        scenarioId: scenario.id,
        projectId: result.projectId,
        runId: result.runId,
        runStatus: result.runStatus,
        evidence: result.evidence,
      });
      entries.push({ verdict, bundle: result.evidence?.bundle ?? null });
      console.log(
        `${scenario.id}: project ${result.projectId}, run ${result.runId} → ${result.runStatus} [${verdict.status}]`,
      );
      for (const reason of verdict.reasons) console.log(`  - ${reason}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'scenario runner threw';
      // #578: a stuck run is the one an operator most needs to open, so the
      // verdict names it whenever the throw carried its identity.
      const identity =
        error instanceof TracerScenarioError
          ? { projectId: error.projectId, runId: error.runId, runStatus: error.runStatus }
          : { projectId: '-', runId: '-', runStatus: 'unknown' };
      entries.push({
        verdict: goldenJourneyVerdictWithoutEvidence(
          { scenarioId: scenario.id, ...identity },
          'failed',
          message,
        ),
        bundle: null,
      });
      console.error(`${scenario.id}: threw before a verdict → ${message}`);
    }
  }

  if (evidenceDir) {
    await writeGoldenJourneyEvidence(resolve(evidenceDir), entries);
    console.log(`evidence written to ${resolve(evidenceDir)}`);
  }

  const passed = entries.filter((entry) => entry.verdict.status === 'passed').length;
  console.log(`golden journey: ${passed}/${entries.length} passed`);
  if (gate && passed !== entries.length) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Tracer runner failed.');
  process.exitCode = 1;
}
