import {
  RegressionGateResultSchema,
  type BenchmarkReport,
  type RegressionGateResult,
} from '@agent-foundry/contracts';

// ponytail: status-only gate (passed -> failed is the only hard failure).
// Duration/repairs deltas are reported but non-blocking, to avoid flaky
// provider-timing gates; add a duration-budget rule only once promotions
// start actually shipping measurable slowdowns.
export function compareBenchmarkReports(
  fresh: BenchmarkReport,
  baseline: BenchmarkReport,
): RegressionGateResult {
  const freshByKey = new Map(fresh.runs.map((run) => [`${run.caseId}::${run.modelId}`, run]));
  const reasons: string[] = [];
  const deltas: RegressionGateResult['deltas'] = [];

  for (const baselineRun of baseline.runs) {
    const key = `${baselineRun.caseId}::${baselineRun.modelId}`;
    const freshRun = freshByKey.get(key);
    if (!freshRun) {
      reasons.push(`${key}: missing from fresh report`);
      continue;
    }
    const statusRegressed = baselineRun.status === 'passed' && freshRun.status === 'failed';
    if (statusRegressed) reasons.push(`${key}: regressed from passed to failed`);
    deltas.push({
      caseId: freshRun.caseId,
      modelId: freshRun.modelId,
      baselineStatus: baselineRun.status,
      freshStatus: freshRun.status,
      statusRegressed,
      durationDeltaMs: freshRun.durationMs - baselineRun.durationMs,
      repairsDelta: freshRun.repairs.iterations - baselineRun.repairs.iterations,
    });
  }

  return RegressionGateResultSchema.parse({
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    baselineRef: baseline.baselineRef,
    freshCreatedAt: fresh.createdAt,
    verdict: reasons.length === 0 ? 'pass' : 'fail',
    reasons,
    deltas,
  });
}
