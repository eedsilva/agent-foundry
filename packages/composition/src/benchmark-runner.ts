import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicWriteJson, ensureDir } from '@agent-foundry/persistence';
import {
  BENCHMARK_CASE_KINDS,
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
  DogfoodTaskSchema,
  type BenchmarkCase,
  type BenchmarkReport,
  type BenchmarkRunRecord,
  type ProviderCanaryProvider,
} from '@agent-foundry/contracts';
import { markdownCell, publishBaselinePair } from './baseline-publish.js';
import { runDogfoodTask, type RunDogfoodTaskOptions } from './dogfood.js';

const BASELINE_STEM = 'v0.9-benchmark';
const FOUNDRY_ROOT = resolve(import.meta.dirname, '../../..');

export interface RunBenchmarkCaseOptions {
  repoRoot: string;
  dataDir?: string;
  executorMode?: 'real' | 'mock';
}

// Deliberately narrower than the full ModelDefinition catalog entry — running
// a case only needs these three fields. A ModelDefinition satisfies this
// structurally, so scripts/benchmark.ts can pass catalog entries straight in.
export interface BenchmarkModelTarget {
  id: string;
  provider: ProviderCanaryProvider;
  model: string;
}

export async function loadBenchmarkCases(dir: string): Promise<BenchmarkCase[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const cases = await Promise.all(
    entries.map(async (name) =>
      BenchmarkCaseSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8'))),
    ),
  );
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

export async function runBenchmarkCase(
  benchmarkCase: BenchmarkCase,
  model: BenchmarkModelTarget,
  options: RunBenchmarkCaseOptions,
): Promise<BenchmarkRunRecord> {
  if (!model.model.trim()) {
    throw new Error(
      `Catalog model ${model.id} does not resolve to an explicit provider model; skip it instead of running.`,
    );
  }

  const dogfoodOptions: RunDogfoodTaskOptions = {
    repoRoot: options.repoRoot,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.executorMode ? { executorMode: options.executorMode } : {}),
    modelOverride: {
      modelId: model.id,
      provider: model.provider,
      model: model.model,
      reason: `Benchmark run of case "${benchmarkCase.id}" (${benchmarkCase.kind})`,
      estimatedImpact: `Measures ${model.id} performance on the ${benchmarkCase.kind} corpus kind`,
    },
  };

  const dogfoodTask = DogfoodTaskSchema.parse({
    id: `${benchmarkCase.id}--${model.id}`,
    title: benchmarkCase.title,
    issueRef: `benchmark:${benchmarkCase.kind}`,
    workflowId: benchmarkCase.workflowId,
    prompt: benchmarkCase.prompt,
    baselineRef: benchmarkCase.baselineRef,
    allowedFiles: benchmarkCase.allowedFiles,
    seedFiles: benchmarkCase.seedFiles,
    ...(benchmarkCase.verifyScript ? { verifyScript: benchmarkCase.verifyScript } : {}),
  });

  const record = await runDogfoodTask(dogfoodTask, dogfoodOptions);
  const { taskId: _taskId, issueRef: _issueRef, humanEdit: _humanEdit, ...rest } = record;

  const benchmarkRecord = BenchmarkRunRecordSchema.parse({
    ...rest,
    caseId: benchmarkCase.id,
    caseKind: benchmarkCase.kind,
    modelId: model.id,
  });

  const recordsDir = options.dataDir ?? join(FOUNDRY_ROOT, '.data', 'benchmark');
  await ensureDir(recordsDir);
  const tag = String(benchmarkRecord.attempt).padStart(2, '0');
  await atomicWriteJson(
    join(recordsDir, `${benchmarkCase.id}--${model.id}-attempt${tag}.json`),
    benchmarkRecord,
  );

  return benchmarkRecord;
}

export function renderBenchmarkMarkdown(report: BenchmarkReport): string {
  const lines = [
    '# v0.9 benchmark baseline',
    '',
    `Frozen at ${report.createdAt}. Baseline ref \`${report.baselineRef}\`. Machine-readable source of truth: \`${BASELINE_STEM}.json\`.`,
    '',
    '## Runs',
    '',
    '| Case | Kind | Model | Attempt | Status | Duration (ms) | Repairs |',
    '| --- | --- | --- | ---: | --- | ---: | --- |',
    ...report.runs.map(
      (run) =>
        `| ${markdownCell(run.caseId)} | ${run.caseKind} | ${markdownCell(run.modelId)} | ${run.attempt} | ${run.status} | ${run.durationMs} | ${run.repairs.iterations} iter / ${run.repairs.repairEvents} repair(s) |`,
    ),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ];
  return lines.join('\n');
}

export async function freezeBenchmarkReport(
  records: BenchmarkRunRecord[],
  options: { baselinesDir: string; baselineRef: string },
): Promise<void> {
  const kinds = new Set(records.map((record) => record.caseKind));
  const missing = BENCHMARK_CASE_KINDS.filter((kind) => !kinds.has(kind));
  if (missing.length > 0) {
    throw new Error(`Benchmark freeze requires every case kind; missing: ${missing.join(', ')}.`);
  }
  if (records.some((record) => record.status === 'failed' && !record.failure)) {
    throw new Error('Every failed benchmark record must carry a failure before freezing.');
  }

  const report = BenchmarkReportSchema.parse({
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    baselineRef: options.baselineRef,
    runs: records,
    limitations: [
      'Each case runs through the real product pipeline with a run-scoped model override; results depend on provider CLI availability and authentication on the host that ran it.',
      'Failures are frozen alongside passes so the baseline reflects true per-model reliability, not a green wall.',
      'expectedSignals on each case are documentation for reviewers; this runner does not automatically grade output against them.',
      'The refactor and review corpus kinds are behavior-preserving by design; a passed verifyScript on those kinds does not by itself confirm the requested change was made — expectedSignals is the human-graded signal for those two kinds.',
    ],
  });

  await publishBaselinePair(
    join(options.baselinesDir, `${BASELINE_STEM}.json`),
    join(options.baselinesDir, `${BASELINE_STEM}.md`),
    `${JSON.stringify(report, null, 2)}\n`,
    renderBenchmarkMarkdown(report),
    {
      restoreFailureMessage: 'Benchmark freeze failed and its baseline pair could not be restored.',
      cleanupFailureMessage: 'Benchmark baseline pair was published but backup cleanup failed.',
    },
  );
}
