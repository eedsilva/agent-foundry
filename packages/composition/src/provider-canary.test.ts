import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ProviderCanaryReportSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type ProviderCanaryProvider,
  type ProviderProbe,
} from '@agent-foundry/contracts';
import {
  CanaryOptInError,
  freezeProviderCanaryReport,
  modelsFromEnvironment,
  runProviderCanaries,
  type ProviderCanaryDependencies,
} from './provider-canary.js';

const providers = ['codex', 'claude', 'agy'] as const;

describe('provider canary runner', () => {
  it('refuses before probing or invoking a provider without the explicit opt-in', async () => {
    let probed = false;
    let invoked = false;
    const dependencies: ProviderCanaryDependencies = {
      async loadProbes() {
        probed = true;
        return readyProbes();
      },
      async execute(_provider, request) {
        invoked = true;
        return successfulResult(request);
      },
    };

    await expect(
      runProviderCanaries({ env: {}, dependencies, models: selectedModels() }),
    ).rejects.toBeInstanceOf(CanaryOptInError);
    expect(probed).toBe(false);
    expect(invoked).toBe(false);
  });

  it('rejects an explicitly blank selected model before probing or invoking providers', async () => {
    let probed = false;
    let invoked = false;
    const dependencies: ProviderCanaryDependencies = {
      async loadProbes() {
        probed = true;
        return readyProbes();
      },
      async execute(_provider, request) {
        invoked = true;
        return successfulResult(request);
      },
    };

    await expect(
      runProviderCanaries({
        env: optedInEnvironment(),
        dependencies,
        models: { ...selectedModels(), codex: '   ' },
      }),
    ).rejects.toThrow(/non-blank model/i);
    expect(probed).toBe(false);
    expect(invoked).toBe(false);
  });

  it('falls back from blank model environment values to explicit non-blank selections', () => {
    expect(
      modelsFromEnvironment({
        CODEX_CANARY_MODEL: '   ',
        CODEX_DEFAULT_MODEL: '\t',
        CLAUDE_CANARY_MODEL: '',
        CLAUDE_BALANCED_MODEL: '  ',
        AGY_CANARY_MODEL: '\n',
        AGY_DEFAULT_MODEL: '',
      }),
    ).toEqual({ codex: 'gpt-5.3-codex', claude: 'sonnet', agy: 'pro' });
  });

  it('records an explicit skipped run for every scenario of an unavailable provider', async () => {
    let invoked = false;
    const unavailable = readyProbes().map((probe) => ({
      ...probe,
      status: 'unavailable' as const,
      message: `${probe.provider} CLI is unavailable.`,
    }));

    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: {
        async loadProbes() {
          return unavailable;
        },
        async execute(_provider, request) {
          invoked = true;
          return successfulResult(request);
        },
      },
    });

    expect(invoked).toBe(false);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report.runs).toHaveLength(9);
    expect(outcome.report.runs.every((run) => run.status === 'skipped')).toBe(true);
    expect(outcome.report.runs.every((run) => run.skipReason?.includes('unavailable'))).toBe(true);
  });

  it('runs the nine provider/scenario pairs serially in isolated temporary repositories', async () => {
    const workspaces: string[] = [];
    const timeouts: number[] = [];
    const prompts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const dependencies = fakeDependencies(async (_provider, request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      workspaces.push(request.cwd);
      timeouts.push(request.timeoutMs);
      prompts.push(request.prompt);
      await applySuccessfulMutation(request);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return successfulResult(request);
    });

    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.runs).toHaveLength(9);
    expect(outcome.report.runs.every((run) => run.status === 'passed')).toBe(true);
    expect(maximumActive).toBe(1);
    expect(new Set(workspaces).size).toBe(9);
    expect(new Set(timeouts)).toEqual(new Set([600_000]));
    expect(prompts).toHaveLength(9);
    expect(prompts.every((prompt) => !/run node --test/i.test(prompt))).toBe(true);
    expect(outcome.report.runs.map(({ provider, scenario }) => `${provider}:${scenario}`)).toEqual(
      providers.flatMap((provider) =>
        ['planning', 'greenfield', 'repair'].map((scenario) => `${provider}:${scenario}`),
      ),
    );
    await expectAllRemoved(workspaces);
  });

  it('fails planning when the provider changes the repository', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        if (request.stepId.endsWith('planning')) {
          await writeFile(join(request.cwd, 'README.md'), 'changed by planning\n');
        } else {
          await applySuccessfulMutation(request);
        }
        return successfulResult(request);
      }),
    });

    const planning = outcome.report.runs.find(
      (run) => run.provider === 'codex' && run.scenario === 'planning',
    );
    expect(outcome.exitCode).toBe(1);
    expect(planning?.status).toBe('failed');
    expect(planning?.verification).toEqual([
      expect.objectContaining({ name: 'no-diff', passed: false }),
    ]);
    expect(planning?.error).toEqual(
      expect.objectContaining({ kind: 'verification', code: 'VERIFICATION_FAILED' }),
    );
  });

  it('fails a mutating scenario when node --test fails', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        if (!request.stepId.endsWith('greenfield')) await applySuccessfulMutation(request);
        return successfulResult(request);
      }),
    });

    const greenfield = outcome.report.runs.find(
      (run) => run.provider === 'codex' && run.scenario === 'greenfield',
    );
    expect(outcome.exitCode).toBe(1);
    expect(greenfield?.status).toBe('failed');
    expect(greenfield?.verification).toContainEqual(
      expect.objectContaining({ name: 'node-test', passed: false }),
    );
  });

  it('fails a mutating scenario when a provider edits a file outside the allowlist', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        await applySuccessfulMutation(request);
        if (request.stepId.endsWith('repair')) {
          await writeFile(join(request.cwd, 'README.md'), 'forbidden edit\n');
        }
        return successfulResult(request);
      }),
    });

    const repair = outcome.report.runs.find(
      (run) => run.provider === 'codex' && run.scenario === 'repair',
    );
    expect(outcome.exitCode).toBe(1);
    expect(repair?.status).toBe('failed');
    expect(repair?.verification).toContainEqual(
      expect.objectContaining({
        name: 'allowed-files',
        passed: false,
        message: 'Workspace changes did not match the scenario allowlist.',
      }),
    );
  });

  it('fails greenfield directly through git diff --check on trailing whitespace', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        await applySuccessfulMutation(request);
        if (request.stepId.endsWith('greenfield')) {
          await writeFile(
            join(request.cwd, 'src', 'greeting.js'),
            'export function greeting(name) { return `Hello, ${name}!`; }  \n',
          );
        }
        return successfulResult(request);
      }),
    });

    const greenfield = outcome.report.runs.find(
      (run) => run.provider === 'codex' && run.scenario === 'greenfield',
    );
    expect(outcome.exitCode).toBe(1);
    expect(greenfield?.verification).toContainEqual(
      expect.objectContaining({ name: 'git-diff-check', passed: false }),
    );
  });

  it('validates the normalized report and never leaks provider output, errors, or temp paths', async () => {
    const workspaces: string[] = [];
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        workspaces.push(request.cwd);
        if (request.stepId === 'codex-planning') {
          throw new Error(`secret stderr in ${request.cwd}`);
        }
        await applySuccessfulMutation(request);
        return {
          ...successfulResult(request),
          stdout: `raw stdout from ${request.cwd}`,
          stderr: 'raw stderr with private-user',
        };
      }),
    });

    expect(ProviderCanaryReportSchema.safeParse(outcome.report).success).toBe(true);
    const serialized = JSON.stringify(outcome.report);
    expect(serialized).not.toContain('raw stdout');
    expect(serialized).not.toContain('raw stderr');
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('secret stderr');
    for (const workspace of workspaces) expect(serialized).not.toContain(workspace);
    expect(outcome.report.runs[0]?.error).toEqual({
      kind: 'execution',
      code: 'EXECUTION_FAILED',
      message: 'Provider execution failed.',
    });
    await expectAllRemoved(workspaces);
  });

  it('removes temporary repositories after both successful and failed executions', async () => {
    const workspaces: string[] = [];
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        workspaces.push(request.cwd);
        if (request.stepId.endsWith('repair')) throw new Error('boom');
        await applySuccessfulMutation(request);
        return successfulResult(request);
      }),
    });

    expect(outcome.exitCode).toBe(1);
    expect(workspaces).toHaveLength(9);
    await expectAllRemoved(workspaces);
  });

  it('fails the run and process outcome when executed-model metadata is unknown', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        await applySuccessfulMutation(request);
        const result = successfulResult(request);
        if (request.stepId === 'claude-repair') delete result.executedModel;
        return result;
      }),
    });

    const unknown = outcome.report.runs.find(
      (run) => run.provider === 'claude' && run.scenario === 'repair',
    );
    expect(outcome.exitCode).toBe(1);
    expect(unknown?.status).toBe('failed');
    expect(unknown?.error).toEqual({
      kind: 'artifact',
      code: 'UNKNOWN_EXECUTED_MODEL',
      message: 'Provider metadata did not identify one executed model.',
    });
  });

  it('fails closed when the provider artifact is not completed', async () => {
    const outcome = await runProviderCanaries({
      env: optedInEnvironment(),
      models: selectedModels(),
      dependencies: fakeDependencies(async (_provider, request) => {
        await applySuccessfulMutation(request);
        const result = successfulResult(request);
        if (request.stepId === 'agy-planning') result.output.status = 'blocked';
        return result;
      }),
    });

    const blocked = outcome.report.runs.find(
      (run) => run.provider === 'agy' && run.scenario === 'planning',
    );
    expect(outcome.exitCode).toBe(1);
    expect(blocked?.status).toBe('failed');
    expect(blocked?.error).toEqual({
      kind: 'artifact',
      code: 'ARTIFACT_NOT_COMPLETED',
      message: 'Provider did not return a completed artifact.',
    });
  });
});

describe('provider canary freeze', () => {
  it('refuses any report without exactly nine passing runs and known executed models', async () => {
    const outcome = await successfulOutcome();
    const root = await mkdtemp(join(tmpdir(), 'agent-foundry-freeze-test-'));

    try {
      await expect(
        freezeProviderCanaryReport(
          { ...outcome.report, runs: outcome.report.runs.slice(0, 8) },
          root,
        ),
      ).rejects.toThrow(/exactly nine/i);
      await expect(
        freezeProviderCanaryReport(
          {
            ...outcome.report,
            runs: outcome.report.runs.map((run, index) =>
              index === 0 ? { ...run, status: 'failed' as const } : run,
            ),
          },
          root,
        ),
      ).rejects.toThrow(/passing/i);
      await expect(
        freezeProviderCanaryReport(
          {
            ...outcome.report,
            runs: outcome.report.runs.map((run, index) => {
              if (index !== 0) return run;
              const { executedModel: _executedModel, ...unknownModel } = run;
              return unknownModel;
            }),
          },
          root,
        ),
      ).rejects.toThrow(/executed model/i);
      await expect(
        access(join(root, 'docs', 'baselines', 'v0.2-provider-canaries.json')),
      ).rejects.toThrow();
      await expect(
        access(join(root, 'docs', 'baselines', 'v0.2-provider-canaries.md')),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses reports without exact passing scenario-specific verification checks', async () => {
    const outcome = await successfulOutcome();
    const root = await mkdtemp(join(tmpdir(), 'agent-foundry-freeze-test-'));
    const replaceVerification = (
      scenario: 'planning' | 'greenfield' | 'repair',
      verification: (typeof outcome.report.runs)[number]['verification'],
    ) => ({
      ...outcome.report,
      runs: outcome.report.runs.map((run) =>
        run.provider === 'codex' && run.scenario === scenario ? { ...run, verification } : run,
      ),
    });

    await expect(
      freezeProviderCanaryReport(replaceVerification('planning', []), root),
    ).rejects.toThrow(/verification/i);
    await expect(
      freezeProviderCanaryReport(
        replaceVerification('planning', [
          outcome.report.runs.find((run) => run.scenario === 'planning')!.verification[0]!,
          { name: 'node-test', passed: true, exitCode: 0, durationMs: 1 },
        ]),
        root,
      ),
    ).rejects.toThrow(/verification/i);
    await expect(
      freezeProviderCanaryReport(
        replaceVerification(
          'greenfield',
          outcome.report.runs
            .find((run) => run.scenario === 'greenfield')!
            .verification.filter((check) => check.name !== 'allowed-files'),
        ),
        root,
      ),
    ).rejects.toThrow(/verification/i);
    await expect(
      freezeProviderCanaryReport(
        replaceVerification(
          'repair',
          outcome.report.runs
            .find((run) => run.scenario === 'repair')!
            .verification.map((check) =>
              check.name === 'git-diff-check' ? { ...check, passed: false } : check,
            ),
        ),
        root,
      ),
    ).rejects.toThrow(/verification/i);
  });

  it('freezes a strict complete nine-run matrix', async () => {
    const outcome = await successfulOutcome();
    const root = await mkdtemp(join(tmpdir(), 'agent-foundry-freeze-test-'));
    await freezeProviderCanaryReport(outcome.report, root);

    const baselineDir = join(root, 'docs', 'baselines');
    const frozen = JSON.parse(
      await readFile(join(baselineDir, 'v0.2-provider-canaries.json'), 'utf8'),
    ) as unknown;
    const markdown = await readFile(join(baselineDir, 'v0.2-provider-canaries.md'), 'utf8');
    expect(frozen).toEqual(outcome.report);
    expect(ProviderCanaryReportSchema.safeParse(frozen).success).toBe(true);
    expect(markdown).toContain('# v0.2 real provider canary baseline');
    expect(markdown).toContain('| Codex | 1.2.3 | Ready |');
    expect(markdown).toContain(
      '| codex | planning | codex-model | codex-executed-model | Passed |',
    );
    expect(markdown).toContain('## Confirmed model aliases');
    expect(markdown).toContain('| codex | canary | codex-model |');
    expect(markdown).toContain('## Limitations');
  });
});

function fakeDependencies(
  execute: (
    provider: ProviderCanaryProvider,
    request: AgentExecutionRequest,
  ) => Promise<AgentExecutionResult>,
): ProviderCanaryDependencies {
  return {
    async loadProbes() {
      return readyProbes();
    },
    execute,
  };
}

function readyProbes(): ProviderProbe[] {
  return providers.map((provider) => ({
    provider,
    status: 'ready',
    version: '1.2.3',
    capabilities: { nonInteractive: true, modelSelection: true, sandbox: true },
    message: `${provider} is ready.`,
  }));
}

function selectedModels(): Record<ProviderCanaryProvider, string> {
  return { codex: 'codex-model', claude: 'claude-model', agy: 'agy-model' };
}

function optedInEnvironment(): NodeJS.ProcessEnv {
  return { RUN_REAL_PROVIDER_CANARIES: 'true' };
}

function successfulResult(request: AgentExecutionRequest): AgentExecutionResult {
  return {
    runId: request.runId,
    provider: request.provider,
    model: request.model,
    executedModel: `${request.provider}-executed-model`,
    exitCode: 0,
    durationMs: 12,
    stdout: '',
    stderr: '',
    output: {
      schemaVersion: '1',
      status: 'completed',
      summary: 'Canary completed.',
      data: {},
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    },
    usage: { inputTokens: 10, outputTokens: 4 },
  };
}

async function applySuccessfulMutation(request: AgentExecutionRequest): Promise<void> {
  if (request.stepId.endsWith('greenfield')) {
    await mkdir(join(request.cwd, 'src'), { recursive: true });
    await writeFile(
      join(request.cwd, 'src', 'greeting.js'),
      'export function greeting(name) { return `Hello, ${name}!`; }\n',
    );
  }
  if (request.stepId.endsWith('repair')) {
    await writeFile(
      join(request.cwd, 'src', 'sum.js'),
      'export function sum(left, right) { return left + right; }\n',
    );
  }
}

async function expectAllRemoved(paths: string[]): Promise<void> {
  for (const path of paths) await expect(access(path)).rejects.toThrow();
}

async function successfulOutcome() {
  return runProviderCanaries({
    env: optedInEnvironment(),
    models: selectedModels(),
    dependencies: fakeDependencies(async (_provider, request) => {
      await applySuccessfulMutation(request);
      return successfulResult(request);
    }),
  });
}
