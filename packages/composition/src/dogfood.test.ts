import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DogfoodReportSchema,
  DogfoodRunRecordSchema,
  DogfoodTaskSchema,
  type DogfoodRunRecord,
} from '@agent-foundry/contracts';
import { YamlWorkflowRepository } from '@agent-foundry/persistence';
import {
  annotateHumanEdits,
  freezeDogfoodReport,
  renderDogfoodMarkdown,
  runDogfoodTask,
} from './dogfood.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const workflowsDir = resolve(repoRoot, 'workflows');
const tasksDir = resolve(repoRoot, 'examples/dogfood/tasks');

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function createFixtureRepo(files: Record<string, string>): Promise<{
  path: string;
  sha: string;
}> {
  const path = await tempDir('dogfood-fixture-');
  for (const [relative, content] of Object.entries(files)) {
    const destination = join(path, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
  await execa('git', ['init', '--quiet'], { cwd: path });
  await execa('git', ['config', 'user.name', 'Dogfood Fixture'], { cwd: path });
  await execa('git', ['config', 'user.email', 'dogfood-fixture@example.invalid'], { cwd: path });
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'fixture baseline'], { cwd: path });
  // Real tasks reference short SHAs of non-tip commits (e.g. 8896a3c), so the
  // fixture baseline must not be a branch tip either.
  const short = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: path });
  await writeFile(join(path, 'EXTRA.txt'), 'later commit\n');
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['commit', '--quiet', '-m', 'later commit'], { cwd: path });
  return { path, sha: short.stdout.trim() };
}

const MINI_PACKAGE = `${JSON.stringify({ name: 'mini', private: true, version: '0.0.0' }, null, 2)}\n`;

function miniTask(overrides: Record<string, unknown>): ReturnType<typeof DogfoodTaskSchema.parse> {
  return DogfoodTaskSchema.parse({
    id: 'mini',
    title: 'Mini task',
    issueRef: 'test/mini#1',
    workflowId: 'dogfood-task-v1',
    prompt:
      'Implement a tiny module inside the seeded workspace so the deterministic verification passes.',
    allowedFiles: ['package.json', 'src/index.js', 'src/index.test.js'],
    seedFiles: [],
    ...overrides,
  });
}

function sampleRecord(overrides: Partial<DogfoodRunRecord> = {}): DogfoodRunRecord {
  return DogfoodRunRecordSchema.parse({
    schemaVersion: '1',
    taskId: 'sample',
    attempt: 1,
    issueRef: 'test/sample#1',
    baselineRef: '8896a3c',
    projectId: 'project',
    runId: 'run',
    startedAt: '2026-07-14T12:00:00.000Z',
    status: 'passed',
    durationMs: 1234,
    checks: [{ name: 'dogfood:verify', exitCode: 0, durationMs: 12, skipped: false }],
    repairs: { iterations: 1, repairEvents: 0 },
    humanEdit: { status: 'pending', files: [] },
    ...overrides,
  });
}

describe('runDogfoodTask (mock mode)', () => {
  it('runs a mock mini-task and writes an append-only record with copied files and a patch', async () => {
    const fixture = await createFixtureRepo({
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    });
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-pass',
      baselineRef: fixture.sha,
      verifyScript: 'node -e "process.exit(0)"',
    });

    const record = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    expect(() => DogfoodRunRecordSchema.parse(record)).not.toThrow();
    expect(record.status).toBe('passed');
    expect(record.attempt).toBe(1);
    expect(record.route).toBeDefined();
    expect(record.executedModel).toBeTruthy();
    expect(record.usage?.inputTokens).toBe(100);
    expect(record.diff?.filesChanged ?? []).toEqual(
      expect.arrayContaining(['src/index.js', 'src/index.test.js']),
    );
    expect(record.checks.some((check) => check.name === 'dogfood:verify')).toBe(true);
    expect(record.repairs.iterations).toBeGreaterThanOrEqual(1);
    expect(record.humanEdit.status).toBe('pending');

    const recordPath = join(dataDir, 'dogfood', 'mini-pass-attempt01.json');
    await expect(readFile(recordPath, 'utf8')).resolves.toContain('"taskId": "mini-pass"');
    await expect(
      readFile(join(dataDir, 'dogfood', 'mini-pass-attempt01-files', 'src', 'index.js'), 'utf8'),
    ).resolves.toContain('createProject');
    await expect(
      readFile(join(dataDir, 'dogfood', 'mini-pass-attempt01.patch.txt'), 'utf8'),
    ).resolves.toContain('index.js');

    // The assembled REQUEST.md lives inside the throwaway runtime data dir,
    // which is removed once the run finishes — it must be copied out before
    // cleanup so the prompt audit trail survives.
    expect(record.promptArtifact).toBe('dogfood/mini-pass-attempt01-request.md');
    await expect(readFile(join(dataDir, record.promptArtifact ?? ''), 'utf8')).resolves.toContain(
      '# Agent execution request',
    );
  }, 60_000);

  it('appends a second attempt without overwriting the first record', async () => {
    const fixture = await createFixtureRepo({
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    });
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-append',
      baselineRef: fixture.sha,
      verifyScript: 'node -e "process.exit(0)"',
    });

    const first = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });
    const second = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    expect(first.attempt).toBe(1);
    expect(second.attempt).toBe(2);
    const files = await readdir(join(dataDir, 'dogfood'));
    expect(files).toContain('mini-append-attempt01.json');
    expect(files).toContain('mini-append-attempt02.json');
  }, 90_000);

  it('records a failed run with a populated failure when the verify script fails', async () => {
    const fixture = await createFixtureRepo({
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    });
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-fail',
      baselineRef: fixture.sha,
      verifyScript: 'node -e "process.exit(1)"',
    });

    const record = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    expect(record.status).toBe('failed');
    expect(record.failure).toBeDefined();
    expect(record.failure?.message.length ?? 0).toBeGreaterThan(0);
    await expect(
      readFile(join(dataDir, 'dogfood', 'mini-fail-attempt01.json'), 'utf8'),
    ).resolves.toContain('"taskId": "mini-fail"');
  }, 60_000);

  it('sanitizes git failures so no stderr text reaches the record', async () => {
    const fixture = await createFixtureRepo({
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    });
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-bad-baseline',
      baselineRef: 'not-a-real-baseline-ref',
    });

    const record = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    expect(record.status).toBe('failed');
    expect(record.failure?.message).toMatch(/^git rev-parse failed \(exit \d+\)$/);
    expect(record.failure?.message).not.toContain('not-a-real-baseline-ref');
    expect(record.failure?.message).not.toContain('fatal');
    await expect(
      readFile(join(dataDir, 'dogfood', 'mini-bad-baseline-attempt01.json'), 'utf8'),
    ).resolves.toContain('"taskId": "mini-bad-baseline"');
  }, 30_000);

  it('flags a diff outside the allowlist as a failed run with failure.kind "allowlist"', async () => {
    const fixture = await createFixtureRepo({
      'package.json': MINI_PACKAGE,
      'src/lib.js': 'export const value = 1;\n',
    });
    const dataDir = await tempDir('dogfood-data-');
    const task = miniTask({
      id: 'mini-allowlist',
      baselineRef: fixture.sha,
      verifyScript: 'node -e "process.exit(0)"',
      // The mock executor also writes src/index.test.js; excluding it here
      // forces an allowlist violation.
      allowedFiles: ['package.json', 'src/index.js'],
    });

    const record = await runDogfoodTask(task, {
      executorMode: 'mock',
      repoRoot: fixture.path,
      dataDir,
    });

    expect(record.status).toBe('failed');
    expect(record.failure?.kind).toBe('allowlist');
    expect(record.failure?.message).toContain('src/index.test.js');
    await expect(
      readFile(join(dataDir, 'dogfood', 'mini-allowlist-attempt01.json'), 'utf8'),
    ).resolves.toContain('"taskId": "mini-allowlist"');
  }, 60_000);
});

describe('freezeDogfoodReport', () => {
  it('refuses fewer than five distinct tasks', async () => {
    const baselinesDir = await tempDir('dogfood-baselines-');
    const records = ['a', 'b', 'c', 'd'].map((id) => sampleRecord({ taskId: id }));
    await expect(
      freezeDogfoodReport(records, { baselinesDir, baselineRef: '8896a3c' }),
    ).rejects.toThrow(/five distinct/i);
  });

  it('freezes five distinct tasks including a failure and renders the table header', async () => {
    const baselinesDir = await tempDir('dogfood-baselines-');
    const records = [
      sampleRecord({ taskId: 't1' }),
      sampleRecord({ taskId: 't2' }),
      sampleRecord({ taskId: 't3' }),
      sampleRecord({ taskId: 't4' }),
      sampleRecord({
        taskId: 't5',
        status: 'failed',
        failure: { kind: 'run', message: 'verification did not approve' },
      }),
    ];

    await freezeDogfoodReport(records, { baselinesDir, baselineRef: '8896a3c' });

    const json = JSON.parse(await readFile(join(baselinesDir, 'v0.2-dogfood.json'), 'utf8')) as {
      runs: unknown[];
    };
    expect(json.runs).toHaveLength(5);
    const markdown = await readFile(join(baselinesDir, 'v0.2-dogfood.md'), 'utf8');
    expect(markdown).toContain('| Task | Attempt | Status |');
  });
});

describe('renderDogfoodMarkdown', () => {
  it('includes the per-run table header', () => {
    const report = DogfoodReportSchema.parse({
      schemaVersion: '1',
      createdAt: '2026-07-14T12:00:00.000Z',
      baselineRef: '8896a3c',
      runs: [sampleRecord()],
      limitations: ['Runs are executed once each.'],
    });
    expect(renderDogfoodMarkdown(report)).toContain('| Task | Attempt | Status |');
  });
});

describe('annotateHumanEdits', () => {
  it('classifies same, modified, and absent against a merged ref', async () => {
    const repo = await tempDir('dogfood-merged-');
    await execa('git', ['init', '--quiet'], { cwd: repo });
    await execa('git', ['config', 'user.name', 'Dogfood Merge'], { cwd: repo });
    await execa('git', ['config', 'user.email', 'dogfood-merge@example.invalid'], { cwd: repo });
    await writeFile(join(repo, 'a.txt'), 'A\n');
    await writeFile(join(repo, 'b.txt'), 'B-base\n');
    await writeFile(join(repo, 'c.txt'), 'C\n');
    await execa('git', ['add', '.'], { cwd: repo });
    await execa('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: repo });
    const baseline = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    await writeFile(join(repo, 'b.txt'), 'B-human\n');
    await rm(join(repo, 'c.txt'));
    await execa('git', ['add', '-A'], { cwd: repo });
    await execa('git', ['commit', '--quiet', '-m', 'merged'], { cwd: repo });
    const merged = (await execa('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();

    const dataDir = await tempDir('dogfood-data-');
    const filesDir = join(dataDir, 'dogfood', 'mini-annotate-attempt01-files');
    await mkdir(filesDir, { recursive: true });
    await writeFile(join(filesDir, 'a.txt'), 'A\n');
    await writeFile(join(filesDir, 'b.txt'), 'B-agent\n');
    await writeFile(join(filesDir, 'c.txt'), 'C\n');

    const record = sampleRecord({
      taskId: 'mini-annotate',
      baselineRef: baseline,
      diff: {
        checkpoint: baseline,
        commit: merged,
        stat: '3 files changed',
        filesChanged: ['a.txt', 'b.txt', 'c.txt'],
      },
    });

    const annotated = (
      await annotateHumanEdits([record], { repoRoot: repo, mergedRef: merged, dataDir })
    )[0]!;

    expect(annotated.humanEdit.status).toBe('recorded');
    const byPath = new Map(
      annotated.humanEdit.files.map((file) => [file.path, file.agentVsMerged]),
    );
    expect(byPath.get('a.txt')).toBe('same');
    expect(byPath.get('b.txt')).toBe('modified');
    expect(byPath.get('c.txt')).toBe('absent');

    const rewritten = JSON.parse(
      await readFile(join(dataDir, 'dogfood', 'mini-annotate-attempt01.json'), 'utf8'),
    ) as DogfoodRunRecord;
    expect(rewritten.humanEdit.status).toBe('recorded');
  }, 30_000);
});

describe('dogfood workflows', () => {
  it('loads dogfood-task-v1 through the real workflow repository', async () => {
    const workflows = new YamlWorkflowRepository(workflowsDir);
    const workflow = await workflows.get('dogfood-task-v1');
    expect(workflow).toBeTruthy();
    expect(workflow.id).toBe('dogfood-task-v1');
  });

  it('loads dogfood-plan-v1 through the real workflow repository', async () => {
    const workflows = new YamlWorkflowRepository(workflowsDir);
    const workflow = await workflows.get('dogfood-plan-v1');
    expect(workflow).toBeTruthy();
    expect(workflow.id).toBe('dogfood-plan-v1');
  });
});

describe('dogfood task definitions', () => {
  it('every task file in examples/dogfood/tasks parses with DogfoodTaskSchema', async () => {
    const entries = (await readdir(tasksDir)).filter((name) => name.endsWith('.json'));
    expect(entries.length).toBeGreaterThanOrEqual(5);

    for (const entry of entries) {
      const raw = await readFile(resolve(tasksDir, entry), 'utf8');
      const parsed = DogfoodTaskSchema.parse(JSON.parse(raw));
      expect(parsed.id.length).toBeGreaterThan(0);
    }
  });

  it('covers all five real v0.2 tasks by id', async () => {
    const entries = (await readdir(tasksDir)).filter((name) => name.endsWith('.json'));
    const tasks = await Promise.all(
      entries.map(async (entry) => {
        const raw = await readFile(resolve(tasksDir, entry), 'utf8');
        return DogfoodTaskSchema.parse(JSON.parse(raw));
      }),
    );
    const ids = tasks.map((task) => task.id).sort();
    expect(ids).toEqual(
      [
        'domain-redaction',
        'event-store-cursor',
        'executor-failure-fixtures',
        'failure-matrix-plan',
        'web-merge-events',
      ].sort(),
    );
  });
});
