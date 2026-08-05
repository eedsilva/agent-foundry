import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    { id: 'opencode-ollama', provider: 'opencode', model: 'qwen2.5-coder:7b' },
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
    localCanary: vi.fn().mockResolvedValue(canary('opencode', 'local')),
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
          'localCanary',
          'haikuCanary',
          'lunaCanary',
        ].map((name) => [name, vi.fn(async () => order.push(name))]),
      ) as Partial<ValidationPreflightChecks>,
    );
    validationChecks.localCanary = vi.fn(async () => {
      order.push('localCanary');
      return canary('opencode', 'local');
    });
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
      'local-canary',
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
      'localCanary',
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
    expect(validationChecks.localCanary).not.toHaveBeenCalled();
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

    const report = await runValidationPreflight(options(validationChecks));

    expect(report.status).toBe('model-failed');
    const failed = report.checks.at(-1);
    expect(failed).toMatchObject({ boundary: 'haiku-canary', status: 'failed' });
    expect(failed?.message).toContain('ENOENT');
    expect(failed?.message).toContain('dist/sidecar.js');
    // The path stays diagnosable; only the account name goes.
    expect(failed?.message).toContain('/Users/[REDACTED]/');
    expect(JSON.stringify(report)).not.toContain('rosalind');
    expect(validationChecks.lunaCanary).not.toHaveBeenCalled();
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
