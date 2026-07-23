import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  BenchmarkRunRecordSchema,
  type BenchmarkRunRecord,
  type ModelDefinition,
} from '@agent-foundry/contracts';
import { loadModelCatalog } from '@agent-foundry/model-router';
import {
  freezeBenchmarkReport,
  loadBenchmarkCases,
  runBenchmarkCase,
} from '../packages/composition/src/benchmark-runner.js';
import { loadDoctorProbes } from '../packages/composition/src/provider-canary.js';

const rootDir = resolve(import.meta.dirname, '..');
const casesDir = resolve(rootDir, 'benchmarks/cases');
const benchmarkDir = resolve(rootDir, '.data/benchmark');
const catalogPath = resolve(rootDir, 'models/catalog.yaml');
const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function loadRecords(): Promise<BenchmarkRunRecord[]> {
  let entries: string[];
  const recordsDir = join(benchmarkDir, 'dogfood');
  try {
    entries = (await readdir(recordsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (name) =>
      BenchmarkRunRecordSchema.parse(JSON.parse(await readFile(join(recordsDir, name), 'utf8'))),
    ),
  );
}

async function resolveModels(): Promise<ModelDefinition[]> {
  const catalog = await loadModelCatalog(catalogPath, process.env);
  const explicit = argValue('--models');
  const selected = explicit ? new Set(explicit.split(',').map((id) => id.trim())) : undefined;
  return catalog.filter(
    (model) => model.model.trim().length > 0 && (!selected || selected.has(model.id)),
  );
}

async function assertRealModeReady(): Promise<void> {
  if (process.env.RUN_REAL_BENCHMARK !== 'true') {
    console.error('Real benchmark runs require RUN_REAL_BENCHMARK=true.');
    process.exit(1);
  }
  const probes = await loadDoctorProbes(rootDir, process.env);
  for (const probe of probes) {
    if (probe.status !== 'ready') console.error(`skip: ${probe.provider} probe reported ${probe.status}.`);
  }
  if (!probes.some((probe) => probe.status === 'ready')) {
    console.error('No provider CLI is ready; refusing to run real benchmark cases.');
    process.exit(1);
  }
}

const executorMode = argValue('--executor-mode') === 'mock' ? ('mock' as const) : ('real' as const);

try {
  if (args.includes('--freeze')) {
    const records = await loadRecords();
    const baselineRefs = new Set(records.map((record) => record.baselineRef));
    if (baselineRefs.size > 1) {
      throw new Error(
        `--freeze requires all records to share one baselineRef; found: ${[...baselineRefs].join(', ')}`,
      );
    }
    const baselineRef = records[0]?.baselineRef ?? 'unknown';
    await freezeBenchmarkReport(records, {
      baselinesDir: resolve(rootDir, 'docs/baselines'),
      baselineRef,
    });
    console.log(`Frozen ${records.length} record(s) into docs/baselines.`);
  } else if (args.includes('--all') || argValue('--case')) {
    if (executorMode === 'real') await assertRealModeReady();
    const cases = await loadBenchmarkCases(casesDir);
    const caseId = argValue('--case');
    const selectedCases = caseId ? cases.filter((benchmarkCase) => benchmarkCase.id === caseId) : cases;
    if (selectedCases.length === 0) {
      console.error(caseId ? `Unknown case: ${caseId}` : 'No benchmark cases found.');
      process.exit(1);
    }
    const models = await resolveModels();
    if (models.length === 0) {
      console.error('No catalog model resolves to an explicit provider model.');
      process.exit(1);
    }
    let failures = 0;
    for (const benchmarkCase of selectedCases) {
      for (const model of models) {
        const record = await runBenchmarkCase(benchmarkCase, model, {
          repoRoot: rootDir,
          dataDir: benchmarkDir,
          executorMode,
        });
        console.log(
          `${record.caseId} x ${record.modelId} attempt ${record.attempt}: ${record.status}` +
            (record.failure ? ` (${record.failure.kind}: ${record.failure.message})` : ''),
        );
        if (record.status === 'failed') failures += 1;
      }
    }
    process.exitCode = failures === 0 ? 0 : 1;
  } else {
    console.error(
      'Usage: tsx scripts/benchmark.ts --case <id> --model <modelId> | --all [--models <id,id>] | --freeze [--executor-mode mock]',
    );
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Benchmark runner failed.');
  process.exitCode = 1;
}
