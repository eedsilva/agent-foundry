import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execa } from 'execa';
import {
  DogfoodReportSchema,
  DogfoodRunRecordSchema,
  DogfoodTaskSchema,
  VerificationReportSchema,
  type DogfoodHumanEdit,
  type DogfoodReport,
  type DogfoodRunRecord,
  type DogfoodTask,
  type ExecutionUsage,
  type RouteDecision,
  type StepAttempt,
  type StepRun,
  type VerificationReport,
} from '@agent-foundry/contracts';
import { createRuntime, type Runtime } from './runtime.js';

// The monorepo root that owns the workflows, model catalog, and harness. This is
// independent of the per-task seed repo, so a task can seed from any checkout while
// the pipeline still loads dogfood-task-v1/dogfood-plan-v1 from here.
const FOUNDRY_ROOT = resolve(import.meta.dirname, '../../..');
const BASELINE_STEM = 'v0.2-dogfood';
// The step whose successful attempt carries the route/model/usage worth recording.
const PRIMARY_STEP_IDS = ['implement', 'plan'] as const;
const MAX_FAILURE_MESSAGE = 500;

export interface RunDogfoodTaskOptions {
  repoRoot: string;
  dataDir?: string;
  executorMode?: 'real' | 'mock';
  attempt?: number;
}

export async function runDogfoodTask(
  task: DogfoodTask,
  options: RunDogfoodTaskOptions,
): Promise<DogfoodRunRecord> {
  const dogfoodDir = join(options.dataDir ?? join(FOUNDRY_ROOT, '.data'), 'dogfood');
  await mkdir(dogfoodDir, { recursive: true });
  const attempt = options.attempt ?? (await countRecords(dogfoodDir, task.id)) + 1;
  const tag = attemptTag(attempt);
  const startedAt = new Date();
  const started = Date.now();
  const runtimeDataDir = await mkdtemp(join(tmpdir(), `dogfood-run-${task.id}-`));

  let projectId = '';
  let runId = '';
  let status: 'passed' | 'failed' = 'failed';
  let failure: DogfoodRunRecord['failure'];
  let route: RouteDecision | undefined;
  let executedModel: string | undefined;
  let usage: ExecutionUsage | undefined;
  let diff: DogfoodRunRecord['diff'];
  let checks: DogfoodRunRecord['checks'] = [];
  let repairs = { iterations: 1, repairEvents: 0 };
  let promptArtifact: string | undefined;

  try {
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: FOUNDRY_ROOT,
      DATA_DIR: runtimeDataDir,
      WORKFLOWS_DIR: join(FOUNDRY_ROOT, 'workflows'),
      EXECUTOR_MODE: options.executorMode ?? 'real',
      RUN_WORKER_INLINE: 'false',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: `dogfood-${task.id}`,
    });

    const project = await runtime.projectService.create({
      name: task.id,
      prd: task.prompt,
      workflowId: task.workflowId,
    });
    projectId = project.id;
    runId = project.currentRunId ?? '';
    const workspacePath = runtime.workspaces.workspacePath(project.id);

    const baseline = await seedWorkspace(workspacePath, task, options.repoRoot);

    await runtime.worker.runOnce();

    const run = runId ? await runtime.runs.get(runId) : null;
    const runCompleted = run?.status === 'completed';

    const stepRuns = runId ? await runtime.stepRuns.list(runId) : [];
    const attemptsByStep = await Promise.all(
      stepRuns.map((step) => runtime.stepAttempts.list(runId, step.id)),
    );
    const implementation = pickImplementationAttempt(stepRuns, attemptsByStep);
    route = implementation?.routeDecision;
    executedModel = implementation?.executedModel;
    usage = implementation?.usage;
    // The assembled prompt lives under the throwaway runtimeDataDir removed in
    // `finally` — copy it out now so the audit trail survives cleanup. If no
    // attempt ever wrote REQUEST.md (e.g. the run failed before implementing),
    // promptArtifact stays unset.
    if (implementation) {
      const requestPath = join(
        workspacePath,
        '.orchestrator',
        'runs',
        runId,
        'steps',
        implementation.stepRunId,
        'attempts',
        implementation.id,
        'REQUEST.md',
      );
      if (existsSync(requestPath)) {
        const requestArtifactName = `${task.id}-attempt${tag}-request.md`;
        await writeFile(join(dogfoodDir, requestArtifactName), await readFile(requestPath));
        promptArtifact = `dogfood/${requestArtifactName}`;
      }
    }

    const events = projectId ? await runtime.events.list(projectId) : [];
    repairs = {
      iterations: Math.max(1, ...stepRuns.map((step) => step.iteration ?? 1)),
      repairEvents: events.filter((event) => event.type === 'quality.repair_requested').length,
    };

    const verification = await loadVerificationReport(runtime, projectId);
    checks = (verification?.commands ?? []).map((command) => ({
      name: command.name,
      exitCode: command.exitCode,
      durationMs: command.durationMs,
      skipped: command.skipped,
    }));

    const head = await gitOutput(workspacePath, ['rev-parse', 'HEAD']);
    const commit = head && head !== baseline ? head : undefined;
    const changedFiles = commit
      ? splitLines(await gitOutput(workspacePath, ['diff', '--name-only', baseline, commit]))
      : [];
    const stat = commit ? await gitOutput(workspacePath, ['diff', '--stat', baseline, commit]) : '';
    diff = {
      ...(baseline ? { checkpoint: baseline } : {}),
      ...(commit ? { commit } : {}),
      stat,
      filesChanged: changedFiles,
    };

    // Persist verbatim copies + the raw patch before the throwaway runtime dir is removed.
    const filesDir = join(dogfoodDir, `${task.id}-attempt${tag}-files`);
    await saveChangedFiles(workspacePath, filesDir, changedFiles);
    const patch = commit ? await gitOutput(workspacePath, ['diff', baseline, commit]) : '';
    await writeFile(
      join(dogfoodDir, `${task.id}-attempt${tag}.patch.txt`),
      patch ? `${patch}\n` : '',
    );

    const verifyApproved = verification ? verification.approved : true;
    const violations = allowlistViolations(changedFiles, task.allowedFiles);
    if (runCompleted && verifyApproved && violations.length === 0) {
      status = 'passed';
    } else {
      status = 'failed';
      failure = !runCompleted
        ? {
            kind: run?.error?.name ?? 'run',
            message: truncate(run?.error?.message ?? 'Run did not complete.'),
          }
        : !verifyApproved
          ? {
              kind: 'verification',
              message: 'Deterministic verification did not approve the change.',
            }
          : {
              kind: 'allowlist',
              message: truncate(`Files changed outside the allowlist: ${violations.join(', ')}`),
            };
    }
  } catch (error) {
    status = 'failed';
    failure = { kind: errorName(error), message: truncate(errorMessage(error)) };
  } finally {
    await rm(runtimeDataDir, { recursive: true, force: true });
  }

  const record = DogfoodRunRecordSchema.parse({
    schemaVersion: '1',
    taskId: task.id,
    attempt,
    issueRef: task.issueRef,
    baselineRef: task.baselineRef,
    projectId,
    runId,
    startedAt: startedAt.toISOString(),
    status,
    durationMs: Date.now() - started,
    ...(route ? { route } : {}),
    ...(executedModel ? { executedModel } : {}),
    ...(usage ? { usage } : {}),
    ...(promptArtifact ? { promptArtifact } : {}),
    ...(diff ? { diff } : {}),
    checks,
    repairs,
    ...(failure ? { failure } : {}),
    humanEdit: { status: 'pending', files: [] },
  });
  await writeFile(
    join(dogfoodDir, `${task.id}-attempt${tag}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}

export async function loadDogfoodTasks(dir: string): Promise<DogfoodTask[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  const tasks = await Promise.all(
    entries.map(async (name) =>
      DogfoodTaskSchema.parse(JSON.parse(await readFile(join(dir, name), 'utf8'))),
    ),
  );
  return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export function renderDogfoodMarkdown(report: DogfoodReport): string {
  const lines = [
    '# v0.2 dogfood baseline',
    '',
    `Frozen at ${report.createdAt}. Baseline ref \`${report.baselineRef}\`. Machine-readable source of truth: \`${BASELINE_STEM}.json\`.`,
    '',
    '## Runs',
    '',
    '| Task | Attempt | Status | Model (selected → executed) | Duration (ms) | Tokens / cost | Repairs | Files | Human edits |',
    '| --- | ---: | --- | --- | ---: | --- | --- | ---: | --- |',
    ...report.runs.map(
      (run) =>
        `| ${run.taskId} | ${run.attempt} | ${run.status} | ${cell(formatModels(run))} | ${run.durationMs} | ${cell(formatUsage(run.usage))} | ${run.repairs.iterations} iter / ${run.repairs.repairEvents} repair(s) | ${run.diff?.filesChanged.length ?? 0} | ${run.humanEdit.status} |`,
    ),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
  ];
  return lines.join('\n');
}

export async function freezeDogfoodReport(
  records: DogfoodRunRecord[],
  options: { baselinesDir: string; baselineRef: string },
): Promise<void> {
  const distinct = new Set(records.map((record) => record.taskId));
  if (distinct.size < 5) {
    throw new Error('Dogfood freeze requires at least five distinct tasks.');
  }
  if (records.some((record) => record.status === 'failed' && !record.failure)) {
    throw new Error('Every failed dogfood record must carry a failure before freezing.');
  }

  const report = DogfoodReportSchema.parse({
    schemaVersion: '1',
    createdAt: new Date().toISOString(),
    baselineRef: options.baselineRef,
    runs: records,
    limitations: [
      'Each task is executed through the real pipeline; results depend on provider availability at run time.',
      'Failures are frozen alongside passes to record the honest state of the loop, not a green wall.',
      'Human-edit annotations, when present, compare the agent output against a single merged reference.',
    ],
  });

  await writeBaselinePair(
    options.baselinesDir,
    `${JSON.stringify(report, null, 2)}\n`,
    renderDogfoodMarkdown(report),
  );
}

export async function annotateHumanEdits(
  records: DogfoodRunRecord[],
  options: { repoRoot: string; mergedRef: string; dataDir?: string },
): Promise<DogfoodRunRecord[]> {
  const dogfoodDir = join(options.dataDir ?? join(FOUNDRY_ROOT, '.data'), 'dogfood');
  await mkdir(dogfoodDir, { recursive: true });
  const annotated: DogfoodRunRecord[] = [];
  for (const record of records) {
    const tag = attemptTag(record.attempt);
    const filesDir = join(dogfoodDir, `${record.taskId}-attempt${tag}-files`);
    const files: DogfoodHumanEdit['files'] = [];
    for (const path of record.diff?.filesChanged ?? []) {
      const classification = await classifyHumanEdit(
        join(filesDir, path),
        options.repoRoot,
        options.mergedRef,
        record.baselineRef,
        path,
      );
      if (classification) files.push({ path, agentVsMerged: classification });
    }
    const updated = DogfoodRunRecordSchema.parse({
      ...record,
      humanEdit: { status: 'recorded', reference: options.mergedRef, files },
    });
    await writeFile(
      join(dogfoodDir, `${record.taskId}-attempt${tag}.json`),
      `${JSON.stringify(updated, null, 2)}\n`,
    );
    annotated.push(updated);
  }
  return annotated;
}

async function seedWorkspace(
  workspacePath: string,
  task: DogfoodTask,
  repoRoot: string,
): Promise<string> {
  await git(workspacePath, ['init', '--quiet']);
  await git(workspacePath, ['config', 'user.name', 'Agent Foundry Dogfood']);
  await git(workspacePath, ['config', 'user.email', 'dogfood@localhost']);
  // Local excludes keep orchestrator run state and installed deps out of the
  // agent's measured diff.
  await appendExclude(workspacePath, ['.orchestrator/', 'node_modules/']);
  // Short SHAs (e.g. 8896a3c) cannot be fetched directly: resolve the full
  // commit in the source repo, fetch its branches and tags, then check out
  // the resolved commit's tree.
  const baselineSha = await gitOutput(repoRoot, [
    'rev-parse',
    '--verify',
    `${task.baselineRef}^{commit}`,
  ]);
  await git(workspacePath, [
    'fetch',
    '--no-tags',
    repoRoot,
    '+refs/heads/*:refs/dogfood/heads/*',
    '+refs/tags/*:refs/dogfood/tags/*',
  ]);
  await git(workspacePath, ['checkout', baselineSha, '--', '.']);

  for (const seed of task.seedFiles) {
    const destination = join(workspacePath, seed.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, seed.content);
  }
  if (task.verifyScript) await injectVerifyScript(workspacePath, task.verifyScript);
  if (
    existsSync(join(workspacePath, 'package-lock.json')) &&
    (task.allowedFiles.length > 0 || task.verifyScript)
  ) {
    const result = await execa('npm', ['ci'], { cwd: workspacePath, reject: false });
    if (result.exitCode !== 0) throw commandFailure('npm ci', result);
  }

  await git(workspacePath, ['add', '-A']);
  await git(workspacePath, [
    'commit',
    '--quiet',
    '-m',
    `dogfood: seed baseline ${task.baselineRef}`,
  ]);
  return gitOutput(workspacePath, ['rev-parse', 'HEAD']);
}

async function injectVerifyScript(workspacePath: string, verifyScript: string): Promise<void> {
  const packagePath = join(workspacePath, 'package.json');
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  } catch {
    pkg = { name: 'dogfood-workspace', private: true };
  }
  const scripts =
    typeof pkg.scripts === 'object' && pkg.scripts !== null
      ? (pkg.scripts as Record<string, string>)
      : {};
  scripts['dogfood:verify'] = verifyScript;
  pkg.scripts = scripts;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function appendExclude(workspacePath: string, patterns: string[]): Promise<void> {
  const excludePath = join(workspacePath, '.git', 'info', 'exclude');
  let current = '';
  try {
    current = await readFile(excludePath, 'utf8');
  } catch {
    current = '';
  }
  const existing = new Set(current.split('\n'));
  const missing = patterns.filter((pattern) => !existing.has(pattern));
  if (missing.length === 0) return;
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`;
  await writeFile(excludePath, `${prefix}${missing.join('\n')}\n`);
}

function pickImplementationAttempt(
  stepRuns: StepRun[],
  attemptsByStep: StepAttempt[][],
): StepAttempt | undefined {
  for (const stepId of PRIMARY_STEP_IDS) {
    const index = stepRuns.findIndex((step) => step.stepId === stepId);
    if (index >= 0) {
      const succeeded = [...attemptsByStep[index]!]
        .reverse()
        .find(
          (candidate) => candidate.executorKind === 'agent' && candidate.status === 'succeeded',
        );
      if (succeeded) return succeeded;
    }
  }
  const agentAttempts = attemptsByStep
    .flat()
    .filter((candidate) => candidate.executorKind === 'agent' && candidate.status === 'succeeded');
  return agentAttempts.at(-1);
}

async function loadVerificationReport(
  runtime: Runtime,
  projectId: string,
): Promise<VerificationReport | null> {
  if (!projectId) return null;
  try {
    const artifact = await runtime.projectService.getArtifact(projectId, 'verification.report');
    return VerificationReportSchema.parse(artifact.content);
  } catch {
    return null;
  }
}

async function classifyHumanEdit(
  agentCopyPath: string,
  repoRoot: string,
  mergedRef: string,
  baselineRef: string,
  path: string,
): Promise<DogfoodHumanEdit['files'][number]['agentVsMerged'] | null> {
  let agentContent: string;
  try {
    agentContent = await readFile(agentCopyPath, 'utf8');
  } catch {
    return null; // ponytail: agent deletions leave no verbatim copy to compare
  }
  const merged = await gitShow(repoRoot, mergedRef, path);
  if (merged !== null) return merged === agentContent ? 'same' : 'modified';
  const baseline = await gitShow(repoRoot, baselineRef, path);
  return baseline !== null ? 'absent' : 'agent-only';
}

async function saveChangedFiles(
  workspacePath: string,
  filesDir: string,
  changedFiles: string[],
): Promise<void> {
  for (const relative of changedFiles) {
    let content: Buffer;
    try {
      content = await readFile(join(workspacePath, relative));
    } catch {
      continue; // ponytail: deleted files have no content to snapshot
    }
    const destination = join(filesDir, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function writeBaselinePair(dir: string, json: string, markdown: string): Promise<void> {
  const jsonPath = join(dir, `${BASELINE_STEM}.json`);
  const markdownPath = join(dir, `${BASELINE_STEM}.md`);
  const suffix = `.${process.pid}-${Date.now()}.tmp`;
  const tmpJson = `${jsonPath}${suffix}`;
  const tmpMarkdown = `${markdownPath}${suffix}`;
  const backupJson = `${jsonPath}${suffix}.backup`;
  const backupMarkdown = `${markdownPath}${suffix}.backup`;
  let jsonBackedUp = false;
  let markdownBackedUp = false;
  let jsonPublished = false;
  let markdownPublished = false;

  await mkdir(dir, { recursive: true });
  try {
    await writeFile(tmpJson, json, { flag: 'wx' });
    await writeFile(tmpMarkdown, markdown, { flag: 'wx' });
    jsonBackedUp = await renameIfPresent(jsonPath, backupJson);
    markdownBackedUp = await renameIfPresent(markdownPath, backupMarkdown);
    await rename(tmpJson, jsonPath);
    jsonPublished = true;
    await rename(tmpMarkdown, markdownPath);
    markdownPublished = true;
  } catch (error) {
    try {
      if (jsonPublished) await rm(jsonPath, { force: true });
      if (markdownPublished) await rm(markdownPath, { force: true });
      if (jsonBackedUp) await rename(backupJson, jsonPath);
      if (markdownBackedUp) await rename(backupMarkdown, markdownPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Dogfood freeze failed and its baseline pair could not be restored.',
      );
    }
    throw error;
  } finally {
    await Promise.allSettled([rm(tmpJson, { force: true }), rm(tmpMarkdown, { force: true })]);
  }
  await Promise.allSettled([rm(backupJson, { force: true }), rm(backupMarkdown, { force: true })]);
}

async function renameIfPresent(source: string, destination: string): Promise<boolean> {
  try {
    await rename(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function allowlistViolations(changedFiles: string[], allowedFiles: string[]): string[] {
  if (allowedFiles.length === 0) return changedFiles; // empty allowlist ⇒ any change is a violation
  return changedFiles.filter((file) => !allowedFiles.includes(file));
}

async function countRecords(dogfoodDir: string, taskId: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dogfoodDir);
  } catch {
    return 0;
  }
  return entries.filter((name) => name.startsWith(`${taskId}-attempt`) && name.endsWith('.json'))
    .length;
}

function formatModels(record: DogfoodRunRecord): string {
  const selected = record.route?.selected.model.id ?? '—';
  const executed = record.executedModel ?? record.route?.executed?.model.id ?? '—';
  return `${selected} → ${executed}`;
}

function formatUsage(usage: ExecutionUsage | undefined): string {
  if (!usage) return 'Not reported';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`USD ${usage.estimatedCostUsd}`);
  return parts.join(', ') || 'Not reported';
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, ' ');
}

function splitLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function attemptTag(attempt: number): string {
  return String(attempt).padStart(2, '0');
}

function truncate(message: string): string {
  return message.length > MAX_FAILURE_MESSAGE ? message.slice(0, MAX_FAILURE_MESSAGE) : message;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'error';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) throw commandFailure(`git ${args[0]}`, result);
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) throw commandFailure(`git ${args[0]}`, result);
  return result.stdout;
}

// Infrastructure failure messages (git, npm) are copied verbatim into
// failure.message, which is frozen into committed baseline JSON — so the
// thrown error carries a fixed, short message only. Full stderr/stdout is
// still logged to the console for local diagnosis.
function commandFailure(
  command: string,
  result: { exitCode?: number; stderr: string; stdout: string },
): Error {
  if (result.stderr || result.stdout) console.error(result.stderr || result.stdout);
  return new Error(`${command} failed (exit ${result.exitCode ?? 'unknown'})`);
}

async function gitShow(repoRoot: string, ref: string, path: string): Promise<string | null> {
  const result = await execa('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
    reject: false,
    stripFinalNewline: false,
  });
  return result.exitCode === 0 ? result.stdout : null;
}
