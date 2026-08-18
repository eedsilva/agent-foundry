import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  ValidationCanaryResult,
  ValidationCampaignPreview,
  ValidationPreflightReport,
} from '@agent-foundry/contracts';
import {
  createProductionValidationPreflightChecks,
  failureDetail,
  persistValidationPreflightReport,
  runValidationPreflight,
  type ValidationPreflightChecks,
} from './validation-preflight.js';

const campaign: ValidationCampaignPreview = {
  schemaVersion: '1',
  id: 'real-todo-v1',
  name: 'Real TODO validation campaign',
  sourceRevision: 'a'.repeat(40),
  allowedModels: [
    { id: 'claude-haiku', provider: 'claude', model: 'haiku' },
    { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
  ],
  routes: [],
  limits: { attemptsPerAgentStep: 1, targetedRepairs: 1, activeTimeMinutes: 45, meteredCostUsd: 2 },
};

const canary = (provider: ValidationCanaryResult['provider'], model: string) => ({
  provider,
  selectedModel: model,
  executedModel: `${provider}-executed`,
  status: 'passed' as const,
});

function checks(overrides: Partial<ValidationPreflightChecks> = {}): ValidationPreflightChecks {
  return {
    disposableEnvironment: vi.fn(),
    docker: vi.fn(),
    supabase: vi.fn(),
    scaffold: vi.fn(),
    applicationHealth: vi.fn(),
    previewGateway: vi.fn(),
    haikuCanary: vi.fn().mockResolvedValue(canary('claude', 'haiku')),
    lunaCanary: vi.fn().mockResolvedValue(canary('codex', 'luna')),
    cleanup: vi.fn(),
    ...overrides,
  };
}

function options(
  validationChecks: ValidationPreflightChecks,
  persist?: (report: ValidationPreflightReport) => Promise<void>,
) {
  return {
    campaign,
    sourceRevision: campaign.sourceRevision,
    rootDirectory: '/repo',
    dataDirectory: '/tmp/agent-foundry-validation',
    executorMode: 'real' as const,
    environmentId: 'validation-preflight-1',
    checks: validationChecks,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    ...(persist ? { persist } : {}),
  };
}

describe('validation preflight', () => {
  it('runs infrastructure then model gates, records identities, and persists safe evidence', async () => {
    const order: string[] = [];
    const validationChecks = checks(
      Object.fromEntries(
        [
          'disposableEnvironment',
          'docker',
          'supabase',
          'scaffold',
          'applicationHealth',
          'previewGateway',
          'haikuCanary',
          'lunaCanary',
        ].map((name) => [name, vi.fn(async () => order.push(name))]),
      ) as Partial<ValidationPreflightChecks>,
    );
    validationChecks.haikuCanary = vi.fn(async () => {
      order.push('haikuCanary');
      return canary('claude', 'haiku');
    });
    validationChecks.lunaCanary = vi.fn(async () => {
      order.push('lunaCanary');
      return canary('codex', 'luna');
    });
    const persist = vi.fn(async () => undefined);

    const report = await runValidationPreflight(options(validationChecks, persist));

    expect(report.status).toBe('passed');
    expect(report.generatedProjectCreated).toBe(false);
    expect(report.environmentId).toBe('validation-preflight-1');
    expect(report.checks.map((check) => check.boundary)).toEqual([
      'source-revision',
      'data-directory',
      'executor-mode',
      'disposable-environment',
      'docker',
      'supabase',
      'scaffold',
      'application-health',
      'preview-gateway',
      'haiku-canary',
      'luna-canary',
    ]);
    expect(order).toEqual([
      'disposableEnvironment',
      'docker',
      'supabase',
      'scaffold',
      'applicationHealth',
      'previewGateway',
      'haikuCanary',
      'lunaCanary',
    ]);
    expect(report.checks.at(-1)).toMatchObject({
      provider: 'codex',
      selectedModel: 'luna',
      executedModel: 'codex-executed',
    });
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ dataDirectory: '[REDACTED]' }));
    expect(validationChecks.cleanup).toHaveBeenCalledOnce();
  });

  it('redacts the report at the file persistence boundary', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'validation-preflight-persist-'));
    try {
      const report = await runValidationPreflight(
        options(
          checks({
            docker: vi.fn(async () => {
              throw new Error('token=secret-value at /Users/edsilva/private/db');
            }),
          }),
        ),
      );

      await persistValidationPreflightReport(dataDirectory, report);

      const persisted = await readFile(
        join(dataDirectory, 'validation-campaign', `preflight-${report.sourceRevision}.json`),
        'utf8',
      );
      expect(persisted).toContain('"dataDirectory": "[REDACTED]"');
      expect(persisted).not.toContain('secret-value');
      expect(persisted).not.toContain('/Users/edsilva/private/db');
    } finally {
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('stops at the failed environment boundary and redacts provider errors', async () => {
    const validationChecks = checks({
      docker: vi.fn(async () => {
        throw new Error('token=secret-value ECONNREFUSED 127.0.0.1:54321');
      }),
    });

    const report = await runValidationPreflight(options(validationChecks));

    expect(report.status).toBe('environment-blocked');
    expect(report.checks.at(-1)).toMatchObject({
      boundary: 'docker',
      status: 'failed',
    });
    // The cause must survive redaction: an operator cannot act on
    // "docker prerequisite failed." alone.
    expect(report.checks.at(-1)?.message).toContain('docker prerequisite failed.');
    expect(report.checks.at(-1)?.message).toContain('ECONNREFUSED 127.0.0.1:54321');
    expect(JSON.stringify(report)).not.toContain('secret-value');
    expect(validationChecks.supabase).not.toHaveBeenCalled();
    expect(validationChecks.haikuCanary).not.toHaveBeenCalled();
    expect(validationChecks.cleanup).toHaveBeenCalledOnce();
  });

  it('keeps the cause when a canary throws, and never leaks the operator home path', async () => {
    const validationChecks = checks({
      haikuCanary: vi.fn(async () => {
        throw new Error(
          "ENOENT: no such file or directory, open '/Users/rosalind/work/dist/sidecar.js'",
        );
      }),
    });
    const persist = vi.fn(async (_report: ValidationPreflightReport) => {});

    const report = await runValidationPreflight(options(validationChecks, persist));

    expect(report.status).toBe('model-failed');
    const failed = report.checks.at(-1);
    expect(failed).toMatchObject({ boundary: 'haiku-canary', status: 'failed' });
    // Assert the persisted report, not the in-memory return: the published
    // artifact is the one #397 attaches, and it is the one that can leak.
    const persisted = persist.mock.calls.at(-1)?.[0];
    const persistedMessage = persisted?.checks.at(-1)?.message ?? '';
    expect(persistedMessage).toContain('ENOENT');
    expect(persistedMessage).toContain('dist/sidecar.js');
    // The path stays diagnosable; only the account name goes.
    expect(persistedMessage).toContain('/Users/[REDACTED]/');
    expect(JSON.stringify(persisted)).not.toContain('rosalind');
    expect(JSON.stringify(report)).not.toContain('rosalind');
    expect(validationChecks.lunaCanary).not.toHaveBeenCalled();
  });

  const MAX_DETAIL_CHARS = 300;

  it('redacts a stderr stream before cutting it to the tail', () => {
    const key = 'sk-ant-api03-QQ7vN9fLb2xKdM4tRw8yZc';
    // Positioned so the 300-char cut lands inside the key: slicing first would
    // drop the `sk-` prefix — the only thing the secret patterns match on — and
    // publish the rest of the key as ordinary trace text.
    const trailing = 'npm error trace line'.repeat(20).slice(0, 275);
    const stream = `npm error 401 Unauthorized: ${key}${trailing}`;
    expect(stream.slice(-MAX_DETAIL_CHARS)).toContain('N9fLb2xKdM4tRw8yZc');
    expect(stream.slice(-MAX_DETAIL_CHARS)).not.toContain('sk-ant');

    const detail = failureDetail(stream);

    expect(detail).not.toContain('N9fLb2xKdM4tRw8yZc');
    expect(detail.length).toBeLessThanOrEqual(MAX_DETAIL_CHARS);
  });

  it('falls back to stdout when the failing tool left stderr empty', () => {
    // pnpm reports a failing child script on stdout; reading stderr alone turned
    // every real build failure in the campaign into "No output."
    const stdout = 'ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  web@0.0.0 build: `next build`';

    expect(failureDetail('', stdout)).toContain('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL');
    expect(failureDetail('   ', stdout)).toContain('ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL');
    // stderr still wins when it carries anything.
    expect(failureDetail('npm error 401', stdout)).toBe('npm error 401');
    expect(failureDetail(undefined, undefined)).toBe('No output.');
  });

  it('reports what a canary returned when it fails without throwing', async () => {
    const validationChecks = checks({
      haikuCanary: vi.fn(async () => ({
        provider: 'claude' as const,
        selectedModel: 'haiku',
        status: 'failed' as const,
      })),
    });

    const report = await runValidationPreflight(options(validationChecks));

    const failed = report.checks.at(-1);
    expect(failed).toMatchObject({
      boundary: 'haiku-canary',
      status: 'failed',
      errorCode: 'UNKNOWN_EXECUTED_MODEL',
    });
    expect(failed?.message).toContain('status=failed');
    expect(failed?.message).toContain('executedModel=missing');
  });

  it('persists the cause a canary reported instead of only its missing model', async () => {
    const validationChecks = checks({
      haikuCanary: vi.fn(async () => ({
        provider: 'claude' as const,
        selectedModel: 'haiku',
        status: 'failed' as const,
        error: {
          kind: 'verification' as const,
          code: 'VERIFICATION_FAILED',
          message: 'Scenario checks failed: node-test, git-diff-check.',
        },
      })),
    });

    const report = await runValidationPreflight(options(validationChecks));

    const failed = report.checks.at(-1);
    expect(failed).toMatchObject({
      boundary: 'haiku-canary',
      status: 'failed',
      errorCode: 'VERIFICATION_FAILED',
    });
    expect(failed?.message).toContain('Scenario checks failed: node-test, git-diff-check.');
  });

  it('falls back safely when a canary returns a free-form error code', async () => {
    const validationChecks = checks({
      haikuCanary: vi.fn(async () => ({
        provider: 'claude' as const,
        selectedModel: 'haiku',
        executedModel: 'claude-haiku-4-5-20251001',
        status: 'failed' as const,
        error: {
          kind: 'execution' as const,
          code: 'provider execution failed',
          message: 'Provider process exited before returning an artifact.',
        },
      })),
    });

    const report = await runValidationPreflight(options(validationChecks));

    expect(report.status).toBe('model-failed');
    expect(report.checks.at(-1)).toMatchObject({
      boundary: 'haiku-canary',
      status: 'failed',
      errorCode: 'CANARY_FAILED',
    });
    expect(report.checks.at(-1)?.message).toContain(
      'Provider process exited before returning an artifact.',
    );
  });

  it('caps a flooded cause so a stdout dump cannot land in the bundle', async () => {
    const validationChecks = checks({
      docker: vi.fn(async () => {
        throw new Error('x'.repeat(5_000));
      }),
    });

    const report = await runValidationPreflight(options(validationChecks));

    const message = report.checks.at(-1)?.message ?? '';
    expect(message.length).toBeLessThan(600);
    expect(message).toContain('…');
  });

  it('stops at the first model canary failure without creating a project', async () => {
    const validationChecks = checks({
      haikuCanary: vi.fn().mockResolvedValue({
        provider: 'claude',
        selectedModel: 'haiku',
        status: 'failed',
      }),
    });

    const report = await runValidationPreflight(options(validationChecks));

    expect(report.status).toBe('model-failed');
    expect(report.checks.at(-1)).toMatchObject({ boundary: 'haiku-canary', status: 'failed' });
    expect(validationChecks.lunaCanary).not.toHaveBeenCalled();
    expect(report.generatedProjectCreated).toBe(false);
  });

  it('blocks a campaign that reuses source-local data', async () => {
    const validationChecks = checks();
    const report = await runValidationPreflight({
      ...options(validationChecks),
      dataDirectory: '/repo/.data',
    });

    expect(report.status).toBe('environment-blocked');
    expect(report.checks.at(-1)?.boundary).toBe('data-directory');
    expect(validationChecks.disposableEnvironment).not.toHaveBeenCalled();
  });

  it('downgrades the report when disposable cleanup fails', async () => {
    const validationChecks = checks({
      cleanup: vi.fn(async () => {
        throw new Error('supabase teardown timed out after 90000ms; token=hunter2');
      }),
    });

    const report = await runValidationPreflight(options(validationChecks));

    expect(report.status).toBe('environment-blocked');
    expect(report.checks.at(-1)).toMatchObject({
      boundary: 'cleanup',
      errorCode: 'CLEANUP_FAILED',
    });
    // Which teardown leaked, and why, is the whole point of the cleanup record.
    expect(report.checks.at(-1)?.message).toContain('supabase teardown timed out after 90000ms');
    expect(JSON.stringify(report)).not.toContain('hunter2');
  });
});

describe('production preflight cleanup', () => {
  it('names the teardown that leaked instead of a bare failure', async () => {
    const generatedProjectRuntime = {
      initialize: vi.fn(),
      health: vi.fn().mockResolvedValue({ health: { state: 'healthy' } }),
      cleanup: vi.fn().mockRejectedValue(new Error('container stop timed out after 90000ms')),
    };
    const production = createProductionValidationPreflightChecks({
      campaign,
      environmentId: 'validation-preflight-1',
      harness: { scaffoldFiles: vi.fn() },
      workspaces: {
        ensure: vi.fn(),
        applyScaffold: vi.fn(),
        workspacePath: vi.fn(),
        cleanup: vi.fn(),
      },
      generatedProjectRuntime,
      previews: { start: vi.fn(), stop: vi.fn() },
      previewRunner: { health: vi.fn() },
      maxOutputBytes: 1_000,
    } as unknown as Parameters<typeof createProductionValidationPreflightChecks>[0]);

    // Only a torn-down resource can leak, so initialize before asserting.
    await production.supabase();

    await expect(production.cleanup()).rejects.toThrow(
      'supabase teardown failed: container stop timed out after 90000ms',
    );
  });
});

describe('production scaffold and preview gateway boundaries', () => {
  const PREVIEW_URL = 'http://127.0.0.1:4000/preview/p1/?token=t';
  const LEAK_VARIABLE = 'AGENT_FOUNDRY_PREFLIGHT_LEAK';

  /** A workspace whose build script records the environment it was spawned in. */
  async function probeWorkspace(): Promise<string> {
    const workspacePath = await mkdtemp(join(tmpdir(), 'af-preflight-scaffold-'));
    await writeFile(
      join(workspacePath, 'package.json'),
      JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        private: true,
        scripts: {
          build:
            "node -e \"require('fs').writeFileSync('env-probe.json', " +
            `JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, leaked: process.env.${LEAK_VARIABLE} ?? null }))"`,
        },
      }),
    );
    await writeFile(
      join(workspacePath, 'package-lock.json'),
      JSON.stringify({
        name: 'probe',
        version: '1.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: { '': { name: 'probe', version: '1.0.0' } },
      }),
    );
    return workspacePath;
  }

  function production(workspacePath: string, overrides: Record<string, unknown> = {}) {
    return createProductionValidationPreflightChecks({
      campaign,
      environmentId: 'validation-preflight-1',
      harness: { scaffoldFiles: vi.fn(async () => []) },
      workspaces: {
        ensure: vi.fn(),
        applyScaffold: vi.fn(),
        workspacePath: vi.fn(() => workspacePath),
        cleanup: vi.fn(),
      },
      ...overrides,
      previews: {
        start: vi.fn(async () => ({ session: { id: 'p1', status: 'running' }, url: PREVIEW_URL })),
        stop: vi.fn(async () => {}),
      },
      previewRunner: { health: vi.fn(async () => ({ state: 'healthy' })) },
      maxOutputBytes: 10_000_000,
      installTimeoutMs: 120_000,
    } as unknown as Parameters<typeof createProductionValidationPreflightChecks>[0]);
  }

  it('stops Supabase before deleting the directory its workdir lives in', async () => {
    const workspacePath = await probeWorkspace();
    const order: string[] = [];
    let releaseSupabase = () => {};
    const supabaseStopped = new Promise<void>((resolve) => {
      releaseSupabase = resolve;
    });
    const checks = production(workspacePath, {
      generatedProjectRuntime: {
        initialize: vi.fn(),
        health: vi.fn(async () => ({ health: { state: 'healthy' } })),
        cleanup: vi.fn(async () => {
          await supabaseStopped;
          order.push('supabase');
        }),
      },
      workspaces: {
        ensure: vi.fn(),
        applyScaffold: vi.fn(),
        workspacePath: vi.fn(() => workspacePath),
        cleanup: vi.fn(async () => {
          order.push('workspace');
        }),
      },
    });

    try {
      await checks.supabase();
      await checks.scaffold();
      const cleanup = checks.cleanup();
      // The rm is instant and `supabase stop --workdir` is not, so a concurrent
      // teardown deletes the workdir out from under the stop and strands a
      // ten-container stack that restart=always then revives on every boot.
      await new Promise((tick) => setImmediate(tick));
      expect(order).toEqual([]);
      releaseSupabase();
      await cleanup;

      expect(order).toEqual(['supabase', 'workspace']);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('builds the generated app under its own environment, not the orchestrator’s', async () => {
    const workspacePath = await probeWorkspace();
    const nodeEnv = process.env.NODE_ENV;
    process.env[LEAK_VARIABLE] = 'foundry-secret';
    process.env.NODE_ENV = 'development';
    try {
      await production(workspacePath).scaffold();

      const probe = JSON.parse(await readFile(join(workspacePath, 'env-probe.json'), 'utf8'));
      // NODE_ENV=development reaches React through the build and kills the
      // prerender worker; every other foundry variable is a secret leak.
      expect(probe.nodeEnv).toBe('production');
      expect(probe.leaked).toBeNull();
    } finally {
      delete process.env[LEAK_VARIABLE];
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('accepts the auth redirect the generated app serves on /', async () => {
    const workspacePath = await probeWorkspace();
    const fetchMock = vi.fn(async () => ({ status: 307 }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const checks = production(workspacePath);
      await checks.scaffold();

      await expect(checks.previewGateway()).resolves.toBeUndefined();
      // Following the redirect drops the `?token=`, and fetch keeps no cookie
      // jar for the one the gateway issues, so the hop arrives unauthorized.
      expect(fetchMock).toHaveBeenCalledWith(
        PREVIEW_URL,
        expect.objectContaining({ redirect: 'manual' }),
      );
    } finally {
      vi.unstubAllGlobals();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('still fails when the gateway itself denies the request', async () => {
    const workspacePath = await probeWorkspace();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 403 }) as Response),
    );
    try {
      const checks = production(workspacePath);
      await checks.scaffold();

      await expect(checks.previewGateway()).rejects.toThrow('status=403');
    } finally {
      vi.unstubAllGlobals();
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
