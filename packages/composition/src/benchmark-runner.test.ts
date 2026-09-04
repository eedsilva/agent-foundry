import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
  BENCHMARK_CASE_KINDS,
} from '@agent-foundry/contracts';
import {
  BASELINE_STEM,
  freezeBenchmarkReport,
  loadBenchmarkCases,
  runBenchmarkCase,
} from './benchmark-runner.js';
import { compareBenchmarkReports } from './regression-gate.js';
import { MINI_PACKAGE, seedFixtureRepo } from './testing-helpers.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const casesDir = resolve(repoRoot, 'benchmarks/cases');

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const suiteDirectories: string[] = [];
afterAll(async () => {
  await Promise.all(
    suiteDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function suiteDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  suiteDirectories.push(dir);
  return dir;
}

let miniFixture: Promise<{ path: string; sha: string }> | undefined;
function sharedMiniFixture(): Promise<{ path: string; sha: string }> {
  return (miniFixture ??= (async () =>
    seedFixtureRepo(await suiteDir('benchmark-fixture-shared-'), {
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    }))());
}

function miniCase(overrides: Record<string, unknown> = {}) {
  return BenchmarkCaseSchema.parse({
    id: 'mini-case',
    title: 'Mini benchmark case',
    kind: 'greenfield',
    workflowId: 'dogfood-task-v1',
    prompt: 'Implement a tiny module inside the seeded workspace so verification passes.',
    baselineRef: 'placeholder',
    allowedFiles: ['package.json', 'src/index.js', 'src/index.test.js'],
    seedFiles: [],
    verifyScript: 'node -e "process.exit(0)"',
    expectedSignals: ['mock executor mutation is present'],
    ...overrides,
  });
}

const MODEL = { id: 'codex-default', provider: 'codex' as const, model: 'gpt-5.6-luna' };

describe('the real benchmark corpus', () => {
  it('every fixture in benchmarks/cases parses as a BenchmarkCase and covers all six kinds', async () => {
    const cases = await loadBenchmarkCases(casesDir);
    const files = (await readdir(casesDir)).filter((name) => name.endsWith('.json'));
    expect(cases).toHaveLength(files.length);

    const kinds = new Set(cases.map((benchmarkCase) => benchmarkCase.kind));
    for (const kind of BENCHMARK_CASE_KINDS) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it('every fixture pins a baselineRef that resolves in this repository', async () => {
    const cases = await loadBenchmarkCases(casesDir);
    for (const benchmarkCase of cases) {
      await expect(
        execa('git', ['cat-file', '-e', `${benchmarkCase.baselineRef}^{commit}`], {
          cwd: repoRoot,
        }),
      ).resolves.toBeDefined();
    }
  });
});

describe('runBenchmarkCase (mock mode)', () => {
  it('applies the given model as a run-scoped override and records comparable metadata across two attempts', async () => {
    const fixture = await sharedMiniFixture();
    const dataDir = await tempDir('benchmark-data-');
    const benchmarkCase = miniCase({ id: 'mini-rerun', baselineRef: fixture.sha });

    const first = await runBenchmarkCase(benchmarkCase, MODEL, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });
    const second = await runBenchmarkCase(benchmarkCase, MODEL, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    for (const record of [first, second]) {
      expect(record.status).toBe('passed');
      expect(record.caseId).toBe('mini-rerun');
      expect(record.caseKind).toBe('greenfield');
      expect(record.modelId).toBe('codex-default');
      expect(record.route?.executed?.model?.provider).toBe('codex');
      expect(record.route?.executed?.model?.model).toBe('gpt-5.6-luna');
    }
    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
  }, 60_000);
});

describe('freezeBenchmarkReport', () => {
  it('requires every corpus kind to be represented before freezing', async () => {
    const fixture = await sharedMiniFixture();
    const record = await runBenchmarkCase(
      miniCase({ id: 'mini-freeze-gate', baselineRef: fixture.sha }),
      MODEL,
      {
        executorMode: 'mock',
        repoRoot: fixture.path,
        dataDir: await tempDir('benchmark-data-'),
      },
    );
    const baselinesDir = await tempDir('benchmark-baselines-');

    await expect(
      freezeBenchmarkReport([record], { baselinesDir, baselineRef: '56568a3' }),
    ).rejects.toThrow(/every case kind/);
  }, 60_000);

  // This is the exact seam that broke: runBenchmarkCase must persist the
  // *reshaped* BenchmarkRunRecord (caseId/caseKind/modelId, not
  // taskId/issueRef/humanEdit) at a location scripts/benchmark.ts's
  // loadRecords() actually reads — not runDogfoodTask's own internal
  // dogfood/ subfolder, which holds DogfoodRunRecord-shaped files that
  // BenchmarkRunRecordSchema.strict() rejects.
  //
  // The disk half runs once, on the shared mini fixture: the seam is common
  // to every case and does not depend on the kind. Running the six real
  // corpus cases installed dependencies per case and timed out on loaded
  // runners without ever reporting a defect — five samples, one of them on a
  // commit that predates the change under review (#693). The remaining kinds
  // exist only to satisfy freezeBenchmarkReport's coverage gate, so they are
  // derived from the record read back off disk and revalidated, never re-run.
  // The real corpus files keep their own coverage: the two tests above parse
  // every case and assert all six kinds.
  it('round-trips a run record through disk exactly as scripts/benchmark.ts reads it back', async () => {
    const fixture = await sharedMiniFixture();
    const dataDir = await tempDir('benchmark-roundtrip-data-');
    const benchmarkCase = miniCase({ id: 'mini-roundtrip', baselineRef: fixture.sha });

    await runBenchmarkCase(benchmarkCase, MODEL, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    // Exactly scripts/benchmark.ts's loadRecords(): readdir, filter .json,
    // JSON.parse + BenchmarkRunRecordSchema.parse each — reading the
    // in-memory record back would not exercise the disk round-trip that
    // broke.
    const entries = (await readdir(dataDir)).filter((name) => name.endsWith('.json'));
    expect(entries).toEqual(['mini-roundtrip--codex-default-attempt01.json']);
    const persisted = await Promise.all(
      entries.map(async (name) =>
        BenchmarkRunRecordSchema.parse(JSON.parse(await readFile(join(dataDir, name), 'utf8'))),
      ),
    );
    const template = persisted[0]!;
    expect(template).toMatchObject({
      caseId: 'mini-roundtrip',
      caseKind: 'greenfield',
      modelId: 'codex-default',
    });

    // Derived, not executed: these only feed freezeBenchmarkReport's coverage
    // gate. They still go through the schema, so a derived record that no
    // longer parses fails here instead of at freeze time.
    const records = [
      ...persisted,
      ...BENCHMARK_CASE_KINDS.filter((kind) => kind !== template.caseKind).map((kind) =>
        BenchmarkRunRecordSchema.parse({
          ...template,
          caseId: `${template.caseId}--${kind}`,
          caseKind: kind,
        }),
      ),
    ];
    expect(records).toHaveLength(BENCHMARK_CASE_KINDS.length);

    const baselinesDir = await tempDir('benchmark-roundtrip-baselines-');
    await expect(
      freezeBenchmarkReport(records, { baselinesDir, baselineRef: '56568a3' }),
    ).resolves.toBeUndefined();

    const jsonPath = join(baselinesDir, 'v0.9-benchmark.json');
    const mdPath = join(baselinesDir, 'v0.9-benchmark.md');
    const parsedReport = BenchmarkReportSchema.parse(JSON.parse(await readFile(jsonPath, 'utf8')));
    expect(parsedReport.runs).toHaveLength(records.length);
    await expect(readFile(mdPath, 'utf8')).resolves.toContain('# v0.9 benchmark baseline');
  }, 60_000);
});

describe('the committed v0.9 baseline', () => {
  it('parses, covers every benchmark case kind, and self-compares clean', async () => {
    const baselinePath = resolve(repoRoot, 'docs/baselines', `${BASELINE_STEM}.json`);
    const baseline = BenchmarkReportSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));

    const coveredKinds = new Set(baseline.runs.map((run) => run.caseKind));
    for (const kind of BENCHMARK_CASE_KINDS) {
      expect(coveredKinds.has(kind)).toBe(true);
    }

    const result = compareBenchmarkReports(baseline, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
  });
});
