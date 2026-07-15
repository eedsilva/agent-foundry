import { lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import {
  AGENT_ARTIFACT_JSON_SCHEMA,
  ProviderCanaryReportSchema,
  ProviderProbeSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type CanaryScenario,
  type CanaryVerificationResult,
  type ProviderCanaryProvider,
  type ProviderCanaryReport,
  type ProviderCanaryRun,
  type ProviderProbe,
} from '@agent-foundry/contracts';
import { AgyCliExecutor, ClaudeCliExecutor, CodexCliExecutor } from '@agent-foundry/executors';
import { markdownCell, publishBaselinePair } from './baseline-publish.js';
import { PROVIDER_CANARY_FIXTURES } from './provider-canary-fixtures.js';

const PROVIDERS = ['codex', 'claude', 'agy'] as const;
const SCENARIOS = ['planning', 'greenfield', 'repair'] as const;
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_BYTES = 5_000_000;
const MAX_FIXTURE_FILE_BYTES = 64 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 256 * 1024;
const BASELINE_STEM = 'v0.2-provider-canaries';
const REQUIRED_VERIFICATION_NAMES: Readonly<Record<CanaryScenario, readonly string[]>> = {
  planning: ['no-diff'],
  greenfield: ['node-test', 'git-diff-check', 'allowed-files'],
  repair: ['node-test', 'git-diff-check', 'allowed-files'],
};

export class CanaryOptInError extends Error {
  constructor() {
    super('Real provider canaries require RUN_REAL_PROVIDER_CANARIES=true.');
    this.name = 'CanaryOptInError';
  }
}

export interface ProviderCanaryDependencies {
  loadProbes(): Promise<ProviderProbe[]>;
  execute(
    provider: ProviderCanaryProvider,
    request: AgentExecutionRequest,
  ): Promise<AgentExecutionResult>;
}

export interface ProviderCanaryOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  models?: Record<ProviderCanaryProvider, string>;
  dependencies?: ProviderCanaryDependencies;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ProviderCanaryOutcome {
  report: ProviderCanaryReport;
  exitCode: 0 | 1;
}

export async function runProviderCanaries(
  options: ProviderCanaryOptions = {},
): Promise<ProviderCanaryOutcome> {
  const env = options.env ?? process.env;
  if (env.RUN_REAL_PROVIDER_CANARIES !== 'true') throw new CanaryOptInError();

  const rootDir = options.rootDir ?? process.cwd();
  const now = options.now ?? (() => new Date());
  const models = normalizeSelectedModels(options.models ?? modelsFromEnvironment(env));
  const dependencies =
    options.dependencies ?? createProductionProviderCanaryDependencies(rootDir, env);
  const loadedProbes = (await dependencies.loadProbes()).map((probe) =>
    ProviderProbeSchema.parse(probe),
  );
  const probes = PROVIDERS.map(
    (provider) =>
      loadedProbes.find((probe) => probe.provider === provider) ?? missingProbe(provider),
  );
  const runs: ProviderCanaryRun[] = [];

  for (const provider of PROVIDERS) {
    const probe = probes.find((candidate) => candidate.provider === provider);
    if (!probe) throw new Error(`Missing normalized probe for ${provider}.`);

    for (const scenario of SCENARIOS) {
      if (probe.status !== 'ready') {
        runs.push({
          provider,
          scenario,
          model: models[provider],
          status: 'skipped',
          durationMs: 0,
          verification: [],
          skipReason: `${provider} provider probe reported ${probe.status}.`,
        });
        continue;
      }

      const run = await executeCanaryScenario({
        provider,
        scenario,
        model: models[provider],
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        dependencies,
      });
      runs.push(run);
      if (run.status === 'failed') await writeFailureDiagnostic(rootDir, run, now());
    }
  }

  const aliases = confirmedAliases(runs);
  const report = ProviderCanaryReportSchema.parse({
    schemaVersion: '1',
    createdAt: now().toISOString(),
    probes,
    runs,
    aliases,
    limitations: [
      'Each provider and scenario is executed once in a dependency-free temporary repository.',
      'Executed models are recorded only when recognized provider metadata reports them.',
    ],
  });

  return {
    report,
    exitCode:
      runs.every((run) => run.status === 'passed' && run.executedModel) &&
      aliases.length === PROVIDERS.length
        ? 0
        : 1,
  };
}

export async function freezeProviderCanaryReport(
  input: ProviderCanaryReport,
  rootDir: string,
  options: { rename?: typeof rename; rm?: typeof rm } = {},
): Promise<void> {
  const report = ProviderCanaryReportSchema.parse(input);
  if (report.runs.length !== 9) {
    throw new Error('Provider canary freeze requires exactly nine runs.');
  }
  if (!report.runs.every((run) => run.status === 'passed')) {
    throw new Error('Provider canary freeze requires nine passing runs.');
  }
  if (!report.runs.every((run) => run.executedModel)) {
    throw new Error('Provider canary freeze requires a known executed model for every run.');
  }
  if (!report.runs.every(hasExactPassingVerification)) {
    throw new Error(
      'Provider canary freeze requires exact passing scenario-specific verification checks.',
    );
  }
  if (!hasCompleteReadyProbeMatrix(report.probes)) {
    throw new Error('Provider canary freeze requires one complete ready probe per provider.');
  }

  const actualMatrix = new Set(report.runs.map((run) => `${run.provider}:${run.scenario}`));
  const requiredMatrix = new Set(
    PROVIDERS.flatMap((provider) => SCENARIOS.map((scenario) => `${provider}:${scenario}`)),
  );
  if (
    actualMatrix.size !== requiredMatrix.size ||
    [...requiredMatrix].some((entry) => !actualMatrix.has(entry))
  ) {
    throw new Error('Provider canary freeze requires one run for every provider/scenario pair.');
  }
  const expectedAliases = confirmedAliases(report.runs);
  if (
    expectedAliases.length !== PROVIDERS.length ||
    report.aliases.length !== expectedAliases.length ||
    expectedAliases.some(
      (expected) =>
        !report.aliases.some(
          (actual) =>
            actual.provider === expected.provider &&
            actual.alias === expected.alias &&
            actual.model === expected.model,
        ),
    )
  ) {
    throw new Error(
      'Provider canary freeze requires aliases observed consistently across all runs.',
    );
  }

  const baselineDirectory = join(rootDir, 'docs', 'baselines');
  await publishBaselinePair(
    join(baselineDirectory, `${BASELINE_STEM}.json`),
    join(baselineDirectory, `${BASELINE_STEM}.md`),
    `${JSON.stringify(report, null, 2)}\n`,
    renderProviderCanaryMarkdown(report),
    {
      ...(options.rename ? { rename: options.rename } : {}),
      ...(options.rm ? { rm: options.rm } : {}),
      restoreFailureMessage:
        'Provider canary freeze failed and its baseline pair could not be restored.',
      cleanupFailureMessage:
        'Provider canary baseline pair was published but backup cleanup failed.',
    },
  );
}

function renderProviderCanaryMarkdown(report: ProviderCanaryReport): string {
  const providerNames: Record<ProviderCanaryProvider, string> = {
    codex: 'Codex',
    claude: 'Claude',
    agy: 'AGY',
  };
  const lines = [
    '# v0.2 real provider canary baseline',
    '',
    `Frozen at ${report.createdAt}. The machine-readable source of truth is \`${BASELINE_STEM}.json\`.`,
    '',
    '## CLI readiness',
    '',
    '| Provider | CLI version | Status |',
    '| --- | --- | --- |',
    ...report.probes.map(
      (probe) =>
        `| ${providerNames[probe.provider]} | ${markdownCell(probe.version ?? 'Unknown')} | ${titleCase(probe.status)} |`,
    ),
    '',
    '## Results',
    '',
    '| Provider | Scenario | Selected model | Executed model | Status | Duration (ms) | Usage | Verification |',
    '| --- | --- | --- | --- | --- | ---: | --- | --- |',
    ...report.runs.map(
      (run) =>
        `| ${run.provider} | ${run.scenario} | ${markdownCell(run.model)} | ${markdownCell(run.executedModel ?? 'Unknown')} | ${titleCase(run.status)} | ${run.durationMs} | ${markdownCell(formatUsage(run.usage))} | ${markdownCell(run.verification.map((check) => `${check.name}: ${check.passed ? 'pass' : 'fail'}`).join(', ') || 'None')} |`,
    ),
    '',
    '## Confirmed model aliases',
    '',
    '| Provider | Selected alias/model | Executed model |',
    '| --- | --- | --- |',
    ...report.aliases.map(
      (alias) =>
        `| ${alias.provider} | ${markdownCell(alias.alias)} | ${markdownCell(alias.model)} |`,
    ),
    '',
    '## Limitations',
    '',
    ...report.limitations.map((limitation) => `- ${limitation}`),
    '',
    'Raw provider output, authentication responses, identities, credentials, session identifiers, and machine-specific temporary paths are intentionally excluded.',
    '',
  ];
  return lines.join('\n');
}

function formatUsage(usage: ProviderCanaryRun['usage']): string {
  if (!usage) return 'Not reported';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`input ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`output ${usage.outputTokens}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`cached ${usage.cachedInputTokens}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`cost USD ${usage.estimatedCostUsd}`);
  return parts.join(', ') || 'Not reported';
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function modelsFromEnvironment(
  env: NodeJS.ProcessEnv,
): Record<ProviderCanaryProvider, string> {
  return {
    codex: firstNonBlank(env.CODEX_CANARY_MODEL, env.CODEX_DEFAULT_MODEL) ?? 'gpt-5.3-codex',
    claude: firstNonBlank(env.CLAUDE_CANARY_MODEL, env.CLAUDE_BALANCED_MODEL) ?? 'sonnet',
    agy: firstNonBlank(env.AGY_CANARY_MODEL, env.AGY_DEFAULT_MODEL) ?? 'pro',
  };
}

function createProductionProviderCanaryDependencies(
  rootDir: string,
  env: NodeJS.ProcessEnv,
): ProviderCanaryDependencies {
  const executors = {
    codex: new CodexCliExecutor(DEFAULT_MAX_OUTPUT_BYTES, true),
    claude: new ClaudeCliExecutor(DEFAULT_MAX_OUTPUT_BYTES),
    agy: new AgyCliExecutor(DEFAULT_MAX_OUTPUT_BYTES, {
      reportConfiguredModel: true,
      newProject: true,
    }),
  };

  return {
    loadProbes: () => loadDoctorProbes(rootDir, env),
    async execute(provider, request) {
      return executors[provider].execute(request);
    },
  };
}

/**
 * Run the provider doctor and return schema-validated readiness probes. Shared
 * by the canary dependencies and the dogfood runner so both load probes the
 * same way. Throws on invalid JSON; callers decide skip-vs-fail per probe.
 */
export async function loadDoctorProbes(
  rootDir: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderProbe[]> {
  const result = await execa(process.execPath, [join(rootDir, 'scripts', 'doctor.mjs'), '--json'], {
    cwd: rootDir,
    env: { ...env, EXECUTOR_MODE: 'real' },
    reject: false,
    encoding: 'utf8',
  });
  try {
    const parsed = JSON.parse(result.stdout) as { probes?: unknown };
    if (!Array.isArray(parsed.probes)) throw new Error('missing probes');
    return parsed.probes.map((probe) => ProviderProbeSchema.parse(probe));
  } catch {
    throw new Error('Provider doctor did not return valid probe JSON.');
  }
}

async function executeCanaryScenario(input: {
  provider: ProviderCanaryProvider;
  scenario: CanaryScenario;
  model: string;
  timeoutMs: number;
  dependencies: ProviderCanaryDependencies;
}): Promise<ProviderCanaryRun> {
  const startedAt = Date.now();
  let workspacePath: string | undefined;
  let verification: CanaryVerificationResult[] = [];

  try {
    const fixtureWorkspace = await createFixtureWorkspace(input.scenario);
    workspacePath = fixtureWorkspace.path;
    const request = await createExecutionRequest(
      input.provider,
      input.scenario,
      input.model,
      input.timeoutMs,
      workspacePath,
    );
    const result = await input.dependencies.execute(input.provider, request);
    verification = await verifyScenario(
      workspacePath,
      input.scenario,
      fixtureWorkspace.baselineCommit,
      fixtureWorkspace.baselineExclude,
    );

    if (!result.executedModel) {
      return {
        provider: input.provider,
        scenario: input.scenario,
        model: input.model,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...(result.usage ? { usage: result.usage } : {}),
        verification,
        error: {
          kind: 'artifact',
          code: 'UNKNOWN_EXECUTED_MODEL',
          message: 'Provider metadata did not identify one executed model.',
        },
      };
    }

    if (result.exitCode !== 0 || result.output.status !== 'completed') {
      return {
        provider: input.provider,
        scenario: input.scenario,
        model: input.model,
        executedModel: result.executedModel,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...(result.usage ? { usage: result.usage } : {}),
        verification,
        error: {
          kind: 'artifact',
          code: 'ARTIFACT_NOT_COMPLETED',
          message: 'Provider did not return a completed artifact.',
        },
      };
    }

    if (verification.some((check) => !check.passed)) {
      return {
        provider: input.provider,
        scenario: input.scenario,
        model: input.model,
        executedModel: result.executedModel,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        ...(result.usage ? { usage: result.usage } : {}),
        verification,
        error: {
          kind: 'verification',
          code: 'VERIFICATION_FAILED',
          message: 'One or more deterministic scenario checks failed.',
        },
      };
    }

    return {
      provider: input.provider,
      scenario: input.scenario,
      model: input.model,
      executedModel: result.executedModel,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      ...(result.usage ? { usage: result.usage } : {}),
      verification,
    };
  } catch {
    return {
      provider: input.provider,
      scenario: input.scenario,
      model: input.model,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      verification,
      error: {
        kind: 'execution',
        code: 'EXECUTION_FAILED',
        message: 'Provider execution failed.',
      },
    };
  } finally {
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  }
}

async function createFixtureWorkspace(
  scenario: CanaryScenario,
): Promise<{ path: string; baselineCommit: string; baselineExclude: string }> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'agent-foundry-provider-canary-'));
  try {
    const fixture = PROVIDER_CANARY_FIXTURES[scenario];
    for (const [relativePath, content] of Object.entries(fixture.files)) {
      const destination = join(workspacePath, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    await runWorkspaceCommand(workspacePath, 'git', ['init', '--quiet']);
    await runWorkspaceCommand(workspacePath, 'git', ['config', 'user.name', 'Provider Canary']);
    await runWorkspaceCommand(workspacePath, 'git', [
      'config',
      'user.email',
      'provider-canary@example.invalid',
    ]);
    await runWorkspaceCommand(workspacePath, 'git', ['add', '.']);
    await runWorkspaceCommand(workspacePath, 'git', [
      'commit',
      '--quiet',
      '-m',
      'fixture baseline',
    ]);
    const baseline = await execa('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      reject: false,
      encoding: 'utf8',
    });
    if (baseline.exitCode !== 0 || !baseline.stdout.trim()) {
      throw new Error('Temporary fixture repository baseline could not be resolved.');
    }
    const baselineExclude = await readFile(join(workspacePath, '.git', 'info', 'exclude'), 'utf8');
    return { path: workspacePath, baselineCommit: baseline.stdout.trim(), baselineExclude };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

async function createExecutionRequest(
  provider: ProviderCanaryProvider,
  scenario: CanaryScenario,
  model: string,
  timeoutMs: number,
  cwd: string,
): Promise<AgentExecutionRequest> {
  const runId = `${provider}-${scenario}`;
  const fixture = PROVIDER_CANARY_FIXTURES[scenario];
  const role = scenario === 'planning' ? 'planner' : scenario === 'repair' ? 'fixer' : 'developer';
  const taskKind = scenario === 'greenfield' ? 'implementation' : scenario;

  return {
    runId,
    stepRunId: `${runId}-step`,
    attemptId: `${runId}-attempt`,
    projectId: 'provider-canary',
    stepId: runId,
    role,
    taskKind,
    provider,
    model,
    prompt: `${fixture.prompt}\n\nYour final response must be one JSON object matching the supplied output schema, with no Markdown fence or surrounding prose.`,
    cwd,
    mutatesWorkspace: fixture.mutatesWorkspace,
    timeoutMs,
    outputSchema: AGENT_ARTIFACT_JSON_SCHEMA,
  };
}

async function verifyScenario(
  workspacePath: string,
  scenario: CanaryScenario,
  baselineCommit: string,
  baselineExclude: string,
): Promise<CanaryVerificationResult[]> {
  if (scenario === 'planning') {
    const result = await noDiffVerification(
      workspacePath,
      scenario,
      baselineCommit,
      baselineExclude,
    );
    return [result];
  }

  const allowedFiles = await allowedFileVerification(
    workspacePath,
    scenario,
    baselineCommit,
    baselineExclude,
  );
  const nodeTest: CanaryVerificationResult = allowedFiles.passed
    ? await commandVerification(
        'node-test',
        workspacePath,
        process.execPath,
        ['--test'],
        'node --test failed.',
      )
    : {
        name: 'node-test',
        passed: false,
        exitCode: 1,
        durationMs: 0,
        message: 'node --test was not run because workspace pre-verification failed.',
      };
  const diffCheck: CanaryVerificationResult = allowedFiles.passed
    ? await gitDiffCheckVerification(workspacePath, baselineCommit)
    : {
        name: 'git-diff-check',
        passed: false,
        exitCode: 1,
        durationMs: 0,
        message: 'git diff --check was not run because workspace pre-verification failed.',
      };
  return [nodeTest, diffCheck, allowedFiles];
}

async function noDiffVerification(
  workspacePath: string,
  scenario: CanaryScenario,
  baselineCommit: string,
  baselineExclude: string,
): Promise<CanaryVerificationResult> {
  const startedAt = Date.now();
  try {
    const passed = await workspaceMatchesFixture(
      workspacePath,
      scenario,
      baselineCommit,
      baselineExclude,
    );
    return {
      name: 'no-diff',
      passed,
      exitCode: passed ? 0 : 1,
      durationMs: Date.now() - startedAt,
      ...(!passed ? { message: 'Planning changed the repository.' } : {}),
    };
  } catch {
    return {
      name: 'no-diff',
      passed: false,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      message: 'Planning changed the repository.',
    };
  }
}

async function gitDiffCheckVerification(
  workspacePath: string,
  baselineCommit: string,
): Promise<CanaryVerificationResult> {
  try {
    const intentToAdd = await execa('git', ['add', '--intent-to-add', '--all'], {
      cwd: workspacePath,
      reject: false,
      encoding: 'utf8',
    });
    if (intentToAdd.exitCode !== 0) {
      return {
        name: 'git-diff-check',
        passed: false,
        exitCode: intentToAdd.exitCode ?? 1,
        durationMs: 0,
        message: 'git diff --check failed.',
      };
    }
  } catch {
    return {
      name: 'git-diff-check',
      passed: false,
      exitCode: 1,
      durationMs: 0,
      message: 'git diff --check failed.',
    };
  }

  return commandVerification(
    'git-diff-check',
    workspacePath,
    'git',
    ['diff', '--check', baselineCommit, '--'],
    'git diff --check failed.',
  );
}

async function commandVerification(
  name: string,
  cwd: string,
  command: string,
  args: string[],
  failureMessage: string,
  accept: (stdout: string) => boolean = () => true,
): Promise<CanaryVerificationResult> {
  const startedAt = Date.now();
  try {
    const result = await execa(command, args, {
      cwd,
      reject: false,
      timeout: 30_000,
      maxBuffer: DEFAULT_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });
    const exitCode = result.exitCode ?? 1;
    const passed = exitCode === 0 && accept(result.stdout);
    return {
      name,
      passed,
      exitCode,
      durationMs: Date.now() - startedAt,
      ...(!passed ? { message: failureMessage } : {}),
    };
  } catch {
    return {
      name,
      passed: false,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      message: failureMessage,
    };
  }
}

async function allowedFileVerification(
  workspacePath: string,
  scenario: Exclude<CanaryScenario, 'planning'>,
  baselineCommit: string,
  baselineExclude: string,
): Promise<CanaryVerificationResult> {
  const startedAt = Date.now();
  try {
    const passed = await workspaceMatchesFixture(
      workspacePath,
      scenario,
      baselineCommit,
      baselineExclude,
    );
    return {
      name: 'allowed-files',
      passed,
      exitCode: passed ? 0 : 1,
      durationMs: Date.now() - startedAt,
      ...(!passed ? { message: 'Workspace changes did not match the scenario allowlist.' } : {}),
    };
  } catch {
    return {
      name: 'allowed-files',
      passed: false,
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      message: 'Workspace changes did not match the scenario allowlist.',
    };
  }
}

async function workspaceMatchesFixture(
  workspacePath: string,
  scenario: CanaryScenario,
  baselineCommit: string,
  baselineExclude: string,
): Promise<boolean> {
  const fixture = PROVIDER_CANARY_FIXTURES[scenario];
  const [head, indexEntries, currentExclude, entries] = await Promise.all([
    execa('git', ['rev-parse', 'HEAD'], {
      cwd: workspacePath,
      reject: false,
      encoding: 'utf8',
    }),
    execa('git', ['ls-files', '-v', '-z'], {
      cwd: workspacePath,
      reject: false,
      encoding: 'utf8',
    }),
    readFile(join(workspacePath, '.git', 'info', 'exclude'), 'utf8'),
    collectWorkspaceEntries(workspacePath),
  ]);
  if (
    head.exitCode !== 0 ||
    head.stdout.trim() !== baselineCommit ||
    indexEntries.exitCode !== 0 ||
    currentExclude !== baselineExclude
  ) {
    return false;
  }

  const trackedEntries = indexEntries.stdout.split('\0').filter(Boolean);
  const expectedPaths = new Set([...Object.keys(fixture.files), ...fixture.allowedFiles]);
  if (
    trackedEntries.some((entry) => !entry.startsWith('H ') || !expectedPaths.has(entry.slice(2))) ||
    Object.keys(fixture.files).some(
      (path) => !trackedEntries.some((entry) => entry.slice(2) === path),
    )
  ) {
    return false;
  }
  for (const [path, content] of Object.entries(fixture.files)) {
    if (fixture.allowedFiles.includes(path)) continue;
    const indexed = await execa('git', ['show', `:${path}`], {
      cwd: workspacePath,
      reject: false,
      encoding: 'utf8',
      stripFinalNewline: false,
    });
    if (indexed.exitCode !== 0 || indexed.stdout !== content) return false;
  }

  if (
    entries.size !== expectedPaths.size ||
    [...entries.keys()].some((path) => !expectedPaths.has(path))
  ) {
    return false;
  }
  let totalBytes = 0;
  for (const path of expectedPaths) {
    const entry = entries.get(path);
    if (!entry || entry.type !== 'file') return false;
    totalBytes += entry.size;
    if (entry.size > MAX_FIXTURE_FILE_BYTES || totalBytes > MAX_FIXTURE_TOTAL_BYTES) return false;
    if (
      !fixture.allowedFiles.includes(path) &&
      (await readFile(join(workspacePath, path), 'utf8')) !== fixture.files[path]
    ) {
      return false;
    }
  }
  return true;
}

async function collectWorkspaceEntries(
  root: string,
  relativeDirectory = '',
): Promise<Map<string, { type: 'file' | 'other'; size: number }>> {
  const entries = new Map<string, { type: 'file' | 'other'; size: number }>();
  const directory = join(root, relativeDirectory);
  for (const name of await readdir(directory)) {
    if (!relativeDirectory && name === '.git') continue;
    const relativePath = relativeDirectory ? join(relativeDirectory, name) : name;
    const absolutePath = join(root, relativePath);
    const status = await lstat(absolutePath);
    if (status.isDirectory()) {
      const children = await collectWorkspaceEntries(root, relativePath);
      for (const [path, entry] of children) entries.set(path, entry);
    } else if (status.isFile()) {
      entries.set(relativePath, { type: 'file', size: status.size });
    } else {
      entries.set(relativePath, { type: 'other', size: status.size });
    }
  }
  return entries;
}

async function runWorkspaceCommand(cwd: string, command: string, args: string[]): Promise<void> {
  const result = await execa(command, args, { cwd, reject: false, encoding: 'utf8' });
  if (result.exitCode !== 0) throw new Error('Temporary fixture repository setup failed.');
}

async function writeFailureDiagnostic(
  rootDir: string,
  run: ProviderCanaryRun,
  createdAt: Date,
): Promise<void> {
  const directory = join(rootDir, '.data', 'provider-canaries');
  await mkdir(directory, { recursive: true });
  const timestamp = createdAt.toISOString().replaceAll(':', '-');
  await writeFile(
    join(directory, `${timestamp}-${run.provider}-${run.scenario}.json`),
    `${JSON.stringify({ schemaVersion: '1', createdAt: createdAt.toISOString(), run }, null, 2)}\n`,
  );
}

function missingProbe(provider: ProviderCanaryProvider): ProviderProbe {
  return {
    provider,
    status: 'incompatible',
    capabilities: { nonInteractive: false, modelSelection: false, sandbox: false },
    message: `${provider} did not return a readiness probe.`,
  };
}

function normalizeSelectedModels(
  models: Record<ProviderCanaryProvider, string>,
): Record<ProviderCanaryProvider, string> {
  return Object.fromEntries(
    PROVIDERS.map((provider) => {
      const model = models[provider].trim();
      if (!model) throw new Error(`${provider} requires a non-blank model selection.`);
      return [provider, model];
    }),
  ) as Record<ProviderCanaryProvider, string>;
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function hasExactPassingVerification(run: ProviderCanaryRun): boolean {
  const required = REQUIRED_VERIFICATION_NAMES[run.scenario];
  if (run.verification.length !== required.length) return false;
  const byName = new Map(run.verification.map((check) => [check.name, check]));
  return (
    byName.size === required.length &&
    required.every((name) => {
      const check = byName.get(name);
      return check?.passed === true && (check.exitCode === undefined || check.exitCode === 0);
    })
  );
}

function confirmedAliases(runs: ProviderCanaryRun[]): ProviderCanaryReport['aliases'] {
  return PROVIDERS.flatMap((provider) => {
    const providerRuns = runs.filter((run) => run.provider === provider);
    if (
      providerRuns.length !== SCENARIOS.length ||
      providerRuns.some((run) => run.status !== 'passed' || !run.executedModel)
    ) {
      return [];
    }
    const selectedModels = new Set(providerRuns.map((run) => run.model));
    const executedModels = new Set(providerRuns.map((run) => run.executedModel));
    if (selectedModels.size !== 1 || executedModels.size !== 1) return [];
    return [
      {
        provider,
        alias: selectedModels.values().next().value!,
        model: executedModels.values().next().value!,
      },
    ];
  });
}

function hasCompleteReadyProbeMatrix(probes: ProviderProbe[]): boolean {
  if (probes.length !== PROVIDERS.length) return false;
  const byProvider = new Map(probes.map((probe) => [probe.provider, probe]));
  return (
    byProvider.size === PROVIDERS.length &&
    PROVIDERS.every((provider) => {
      const probe = byProvider.get(provider);
      return (
        probe?.status === 'ready' &&
        Boolean(probe.version) &&
        Object.values(probe.capabilities).every(Boolean)
      );
    })
  );
}
