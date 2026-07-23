import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BenchmarkCaseSchema,
  BenchmarkReportSchema,
  BenchmarkRunRecordSchema,
  BENCHMARK_CASE_KINDS,
} from '@agent-foundry/contracts';
import { freezeBenchmarkReport, loadBenchmarkCases, runBenchmarkCase } from './benchmark-runner.js';

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

// See the equivalent comment in dogfood.test.ts: createModelOverride validates
// its (modelId, provider, model) tuple against the interpolated
// models/catalog.yaml entry, so CODEX_DEFAULT_MODEL must be set to exactly
// MODEL.model below for the whole file's runBenchmarkCase(..., MODEL, ...)
// calls to pass override validation.
let previousCodexModel: string | undefined;
beforeAll(() => {
  previousCodexModel = process.env.CODEX_DEFAULT_MODEL;
  process.env.CODEX_DEFAULT_MODEL = 'benchmark-fixture-model';
});
afterAll(() => {
  if (previousCodexModel === undefined) delete process.env.CODEX_DEFAULT_MODEL;
  else process.env.CODEX_DEFAULT_MODEL = previousCodexModel;
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
  return (miniFixture ??= (async () => {
    const path = await suiteDir('benchmark-fixture-shared-');
    const MINI_PACKAGE = `${JSON.stringify({ name: 'mini', private: true, version: '0.0.0' }, null, 2)}\n`;
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const files: Record<string, string> = {
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const destination = join(path, relative);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await execa('git', ['init', '--quiet'], { cwd: path });
    await execa('git', ['config', 'user.name', 'Benchmark Fixture'], { cwd: path });
    await execa('git', ['config', 'user.email', 'benchmark-fixture@example.invalid'], {
      cwd: path,
    });
    await execa('git', ['add', '.'], { cwd: path });
    await execa('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: path });
    const short = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: path });
    await writeFile(join(path, 'EXTRA.txt'), 'later commit\n');
    await execa('git', ['add', '.'], { cwd: path });
    await execa('git', ['commit', '--quiet', '-m', 'later commit'], { cwd: path });
    return { path, sha: short.stdout.trim() };
  })());
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

const MODEL = { id: 'codex-default', provider: 'codex' as const, model: 'benchmark-fixture-model' };

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
      expect(record.route?.executed?.model?.model).toBe('benchmark-fixture-model');
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
  // BenchmarkRunRecordSchema.strict() rejects. Round-trip through disk the
  // same way the CLI does: run every real corpus case, re-read the written
  // JSON files off disk, re-parse them as BenchmarkRunRecord, and only then
  // freeze.
  it('round-trips the real corpus through disk exactly as scripts/benchmark.ts reads it back', async () => {
    const cases = await loadBenchmarkCases(casesDir);
    const dataDir = await tempDir('benchmark-roundtrip-data-');

    for (const benchmarkCase of cases) {
      await runBenchmarkCase(benchmarkCase, MODEL, {
        executorMode: 'mock',
        repoRoot,
        dataDir,
      });
    }

    // Exactly scripts/benchmark.ts's loadRecords(): readdir, filter .json,
    // JSON.parse + BenchmarkRunRecordSchema.parse each — reading the
    // in-memory records back would not exercise the disk round-trip that
    // broke.
    const entries = (await readdir(dataDir)).filter((name) => name.endsWith('.json'));
    expect(entries.length).toBeGreaterThanOrEqual(cases.length);
    const records = await Promise.all(
      entries.map(async (name) =>
        BenchmarkRunRecordSchema.parse(JSON.parse(await readFile(join(dataDir, name), 'utf8'))),
      ),
    );

    const baselinesDir = await tempDir('benchmark-roundtrip-baselines-');
    await expect(
      freezeBenchmarkReport(records, { baselinesDir, baselineRef: '56568a3' }),
    ).resolves.toBeUndefined();

    const jsonPath = join(baselinesDir, 'v0.9-benchmark.json');
    const mdPath = join(baselinesDir, 'v0.9-benchmark.md');
    const parsedReport = BenchmarkReportSchema.parse(JSON.parse(await readFile(jsonPath, 'utf8')));
    expect(parsedReport.runs).toHaveLength(records.length);
    await expect(readFile(mdPath, 'utf8')).resolves.toContain('# v0.9 benchmark baseline');
  }, 300_000);
});
