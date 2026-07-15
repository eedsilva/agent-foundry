import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DogfoodRunRecordSchema, type DogfoodRunRecord } from '@agent-foundry/contracts';
import {
  annotateHumanEdits,
  freezeDogfoodReport,
  loadDogfoodTasks,
  runDogfoodTask,
} from '../packages/composition/src/dogfood.js';
import { loadDoctorProbes } from '../packages/composition/src/provider-canary.js';

// Anchor to the repo root (this script lives at <root>/scripts/dogfood.ts) so
// the CLI resolves the same .data/dogfood records that runDogfoodTask writes
// by default, regardless of the invoking cwd.
const rootDir = resolve(import.meta.dirname, '..');
const tasksDir = resolve(rootDir, 'examples/dogfood/tasks');
const dogfoodDir = resolve(rootDir, '.data/dogfood');
const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function loadRecords(): Promise<DogfoodRunRecord[]> {
  let entries: string[];
  try {
    entries = (await readdir(dogfoodDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return Promise.all(
    entries.map(async (name) =>
      DogfoodRunRecordSchema.parse(JSON.parse(await readFile(join(dogfoodDir, name), 'utf8'))),
    ),
  );
}

async function assertRealModeReady(): Promise<void> {
  if (process.env.RUN_REAL_DOGFOOD !== 'true') {
    console.error('Real dogfood runs require RUN_REAL_DOGFOOD=true.');
    process.exit(1);
  }
  let probes: Awaited<ReturnType<typeof loadDoctorProbes>>;
  try {
    probes = await loadDoctorProbes(rootDir, process.env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : 'Provider doctor did not return valid probe JSON.',
    );
    process.exit(1);
  }
  // Canary style: a non-ready provider is a skip, not a failure — routing can
  // still fall back to the ready ones. No ready provider at all is fatal.
  for (const probe of probes) {
    if (probe.status !== 'ready') {
      console.error(`skip: ${probe.provider} probe reported ${probe.status}.`);
    }
  }
  if (!probes.some((probe) => probe.status === 'ready')) {
    console.error('No provider CLI is ready; refusing to run real dogfood tasks.');
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
    await freezeDogfoodReport(records, {
      baselinesDir: resolve(rootDir, 'docs/baselines'),
      baselineRef,
    });
    console.log(`Frozen ${records.length} record(s) into docs/baselines.`);
  } else if (argValue('--annotate-human-edits')) {
    const mergedRef = argValue('--annotate-human-edits')!;
    // Human-reviewed merges live on different sibling branches per task group,
    // so annotation runs per-group: --task selects which records this ref applies to.
    const taskId = argValue('--task');
    const records = await loadRecords();
    const selected = taskId ? records.filter((record) => record.taskId === taskId) : records;
    const notes = argValue('--notes');
    const annotated = await annotateHumanEdits(selected, {
      repoRoot: rootDir,
      mergedRef,
      ...(notes ? { notes } : {}),
    });
    console.log(`Annotated ${annotated.length} record(s) against ${mergedRef}.`);
  } else if (args.includes('--all') || argValue('--task')) {
    if (executorMode === 'real') await assertRealModeReady();
    const tasks = await loadDogfoodTasks(tasksDir);
    const taskId = argValue('--task');
    const selected = taskId ? tasks.filter((task) => task.id === taskId) : tasks;
    if (selected.length === 0) {
      console.error(taskId ? `Unknown task: ${taskId}` : 'No dogfood tasks found.');
      process.exit(1);
    }
    let failures = 0;
    for (const task of selected) {
      const record = await runDogfoodTask(task, { repoRoot: rootDir, executorMode });
      console.log(
        `${record.taskId} attempt ${record.attempt}: ${record.status}` +
          (record.failure ? ` (${record.failure.kind}: ${record.failure.message})` : ''),
      );
      if (record.status === 'failed') failures += 1;
    }
    process.exitCode = failures === 0 ? 0 : 1;
  } else {
    console.error(
      'Usage: tsx scripts/dogfood.ts --task <id> | --all | --freeze | --annotate-human-edits <ref> [--executor-mode mock]',
    );
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Dogfood runner failed.');
  process.exitCode = 1;
}
