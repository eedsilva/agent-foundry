import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execa } from 'execa';
import {
  ValidationCanaryResultSchema,
  ValidationPreflightReportSchema,
  type ValidationCanaryResult,
  type ValidationPreflightBoundary,
  type ValidationPreflightCheck,
  type ValidationPreflightReport,
  type ValidationPreflightStatus,
  type ValidationCampaignPreview,
  type PreviewSession,
  type PreviewWorkspaceRef,
} from '@agent-foundry/contracts';
import type {
  GeneratedProjectRuntime,
  HarnessRepository,
  PreviewRunner,
  WorkspaceManager,
} from '@agent-foundry/domain';
import { redactString } from '@agent-foundry/domain';
import { runReproducibleInstall, resolvePreviewCommandPlan } from '@agent-foundry/executors';
import type { PreviewService } from '@agent-foundry/orchestrator';
import {
  createValidationCampaignCanaryDependencies,
  runValidationCampaignCanary,
  type ValidationCanaryDependencies,
} from './provider-canary.js';

export interface ValidationPreflightChecks {
  disposableEnvironment(): Promise<void>;
  docker(): Promise<void>;
  supabase(): Promise<void>;
  scaffold(): Promise<void>;
  applicationHealth(): Promise<void>;
  previewGateway(): Promise<void>;
  localCanary(): Promise<ValidationCanaryResult>;
  haikuCanary(): Promise<ValidationCanaryResult>;
  lunaCanary(): Promise<ValidationCanaryResult>;
  cleanup(): Promise<void>;
}

export interface ValidationPreflightOptions {
  campaign: ValidationCampaignPreview;
  sourceRevision: string;
  rootDirectory: string;
  dataDirectory: string;
  executorMode: 'real' | 'mock';
  environmentId: string;
  checks: ValidationPreflightChecks;
  now?: () => Date;
  persist?: (report: ValidationPreflightReport) => Promise<void>;
}

export interface ProductionValidationPreflightOptions {
  campaign: ValidationCampaignPreview;
  environmentId: string;
  harness: Pick<HarnessRepository, 'scaffoldFiles'>;
  workspaces: Pick<WorkspaceManager, 'ensure' | 'applyScaffold' | 'workspacePath' | 'cleanup'>;
  generatedProjectRuntime?: Pick<GeneratedProjectRuntime, 'initialize' | 'health' | 'cleanup'>;
  previews: Pick<PreviewService, 'start' | 'stop'>;
  previewRunner: Pick<PreviewRunner, 'health'>;
  canaryDependencies?: ValidationCanaryDependencies;
  maxOutputBytes: number;
  installTimeoutMs?: number;
}

const PERSONAL_PATH_PATTERN = /(?:\/Users|\/home)\/[^\s"'`]+/g;

export function redactValidationPreflightReport(
  report: ValidationPreflightReport,
): ValidationPreflightReport {
  return {
    ...report,
    dataDirectory: '[REDACTED]',
    checks: report.checks.map((check) => ({
      ...check,
      ...(check.message
        ? {
            message: redactString(check.message).replace(PERSONAL_PATH_PATTERN, '[REDACTED]'),
          }
        : {}),
    })),
  };
}

export async function runValidationPreflight(
  options: ValidationPreflightOptions,
): Promise<ValidationPreflightReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const checks: ValidationPreflightCheck[] = [];
  let status: ValidationPreflightStatus = 'passed';
  let report: ValidationPreflightReport | undefined;
  let cleanupFailed = false;
  const cleanupStartedAt = Date.now();

  try {
    if (
      !(await recordCheck(checks, 'source-revision', () => {
        if (!/^[0-9a-f]{40}$/.test(options.sourceRevision)) {
          throw new Error('invalid source revision');
        }
      }))
    ) {
      status = 'environment-blocked';
    } else if (
      !(await recordCheck(checks, 'data-directory', () => {
        if (!isExternalDirectory(options.rootDirectory, options.dataDirectory)) {
          throw new Error('data directory is not isolated');
        }
      }))
    ) {
      status = 'environment-blocked';
    } else if (
      !(await recordCheck(checks, 'executor-mode', () => {
        if (options.executorMode !== 'real') throw new Error('real executor mode is required');
      }))
    ) {
      status = 'environment-blocked';
    } else {
      const environmentChecks: Array<readonly [ValidationPreflightBoundary, () => Promise<void>]> =
        [
          ['disposable-environment', options.checks.disposableEnvironment],
          ['docker', options.checks.docker],
          ['supabase', options.checks.supabase],
          ['scaffold', options.checks.scaffold],
          ['application-health', options.checks.applicationHealth],
          ['preview-gateway', options.checks.previewGateway],
        ];

      for (const [boundary, check] of environmentChecks) {
        if (!(await recordCheck(checks, boundary, check))) {
          status = 'environment-blocked';
          break;
        }
      }

      if (status === 'passed') {
        const canaries: Array<
          readonly [ValidationPreflightBoundary, () => Promise<ValidationCanaryResult>]
        > = [
          ['local-canary', options.checks.localCanary],
          ['haiku-canary', options.checks.haikuCanary],
          ['luna-canary', options.checks.lunaCanary],
        ];
        for (const [boundary, canary] of canaries) {
          const result = await recordCanaryCheck(checks, boundary, canary);
          if (!result) {
            status = 'model-failed';
            break;
          }
        }
      }
    }

    const completedAt = now().toISOString();
    report = ValidationPreflightReportSchema.parse({
      schemaVersion: '1',
      campaignId: options.campaign.id,
      sourceRevision: options.sourceRevision,
      dataDirectory: options.dataDirectory,
      executorMode: options.executorMode,
      environmentId: options.environmentId,
      startedAt,
      completedAt,
      status,
      checks,
      generatedProjectCreated: false,
    });
  } finally {
    try {
      await options.checks.cleanup();
    } catch {
      cleanupFailed = true;
    }
  }

  if (!report) throw new Error('Validation preflight did not produce a report.');
  if (cleanupFailed) {
    report = ValidationPreflightReportSchema.parse({
      ...report,
      status: 'environment-blocked',
      checks: [
        ...report.checks,
        {
          boundary: 'cleanup',
          status: 'failed',
          durationMs: Date.now() - cleanupStartedAt,
          errorCode: 'CLEANUP_FAILED',
          message: 'Disposable preflight resources could not be cleaned up.',
        },
      ],
    });
  }
  await options.persist?.(redactValidationPreflightReport(report));
  return report;
}

export function createProductionValidationPreflightChecks(
  options: ProductionValidationPreflightOptions,
): ValidationPreflightChecks {
  let environmentInitialized = false;
  let workspaceCreated = false;
  let preview: { session: PreviewSession; url: string } | undefined;
  const canaryDependencies =
    options.canaryDependencies ?? createValidationCampaignCanaryDependencies();

  const model = (id: string) => {
    const selected = options.campaign.allowedModels.find((candidate) => candidate.id === id);
    if (!selected) throw new Error(`Campaign model ${id} is not configured.`);
    return selected;
  };

  return {
    async disposableEnvironment() {
      if (!options.generatedProjectRuntime) {
        throw new Error('Disposable project runtime is not configured.');
      }
    },
    async docker() {
      const result = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], {
        reject: false,
        timeout: 30_000,
        maxBuffer: options.maxOutputBytes,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error('Docker is not ready.');
    },
    async supabase() {
      if (!options.generatedProjectRuntime) throw new Error('Supabase runtime is unavailable.');
      await options.generatedProjectRuntime.initialize({ projectId: options.environmentId });
      environmentInitialized = true;
      const environment = await options.generatedProjectRuntime.health(options.environmentId);
      if (environment.health.state !== 'healthy') throw new Error('Supabase is not healthy.');
    },
    async scaffold() {
      await options.workspaces.ensure(options.environmentId);
      workspaceCreated = true;
      await options.workspaces.applyScaffold(
        options.environmentId,
        await options.harness.scaffoldFiles('nextjs'),
      );
      const workspacePath = options.workspaces.workspacePath(options.environmentId);
      const plan = await resolvePreviewCommandPlan(workspacePath);
      if (!plan.build.ok) throw new Error(plan.build.reason);
      const install = await runReproducibleInstall(plan, workspacePath, {
        timeoutMs: options.installTimeoutMs ?? 120_000,
        maxOutputBytes: options.maxOutputBytes,
      });
      if (!install.ok) throw new Error('Scaffold install failed.');
      const build = await execa(plan.build.command, plan.build.args, {
        cwd: workspacePath,
        reject: false,
        timeout: options.installTimeoutMs ?? 120_000,
        maxBuffer: options.maxOutputBytes,
      });
      if (build.exitCode !== 0) throw new Error('Scaffold build failed.');
      preview = await options.previews.start({
        workspaceRef: {
          projectId: options.environmentId,
          workspacePath,
        } satisfies PreviewWorkspaceRef,
      });
      if (preview.session.status !== 'running' || !preview.url) {
        throw new Error('Scaffold preview did not start.');
      }
    },
    async applicationHealth() {
      if (!preview) throw new Error('Scaffold preview is unavailable.');
      const health = await options.previewRunner.health(preview.session);
      if (health.state !== 'healthy') throw new Error('Generated application is not healthy.');
    },
    async previewGateway() {
      if (!preview) throw new Error('Preview gateway is unavailable.');
      const response = await fetch(preview.url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Preview gateway returned a non-success response.');
    },
    localCanary: () =>
      runValidationCampaignCanary({
        model: model('opencode-ollama'),
        taskKind: 'planning',
        dependencies: canaryDependencies,
      }),
    haikuCanary: () =>
      runValidationCampaignCanary({
        model: model('claude-haiku'),
        taskKind: 'planning',
        dependencies: canaryDependencies,
      }),
    lunaCanary: () =>
      runValidationCampaignCanary({
        model: model('codex-default'),
        taskKind: 'implementation',
        dependencies: canaryDependencies,
      }),
    async cleanup() {
      const results = await Promise.allSettled([
        preview ? options.previews.stop(preview.session.id) : Promise.resolve(),
        workspaceCreated ? options.workspaces.cleanup(options.environmentId) : Promise.resolve(),
        environmentInitialized && options.generatedProjectRuntime
          ? options.generatedProjectRuntime.cleanup({
              projectId: options.environmentId,
              confirmation: {
                confirmed: true,
                backupCreatedAt: new Date(Date.now() - 1_000).toISOString(),
              },
            })
          : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Preflight cleanup failed.');
      }
    },
  };
}

export async function persistValidationPreflightReport(
  dataDirectory: string,
  report: ValidationPreflightReport,
): Promise<void> {
  const safeReport = redactValidationPreflightReport(report);
  const directory = join(dataDirectory, 'validation-campaign');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, `preflight-${safeReport.sourceRevision}.json`),
    `${JSON.stringify(safeReport, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

export async function readValidationPreflightReport(
  dataDirectory: string,
  sourceRevision: string,
): Promise<ValidationPreflightReport | undefined> {
  try {
    const content = await readFile(
      join(dataDirectory, 'validation-campaign', `preflight-${sourceRevision}.json`),
      'utf8',
    );
    return ValidationPreflightReportSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function isExternalDirectory(rootDirectory: string, dataDirectory: string): boolean {
  const path = relative(resolve(rootDirectory), resolve(dataDirectory));
  return path !== '' && (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`));
}

async function recordCheck(
  checks: ValidationPreflightCheck[],
  boundary: ValidationPreflightBoundary,
  check: () => void | Promise<void>,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    await check();
    checks.push({ boundary, status: 'passed', durationMs: Date.now() - startedAt });
    return true;
  } catch {
    checks.push({
      boundary,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: 'PREFLIGHT_FAILED',
      message: `${boundary} prerequisite failed.`,
    });
    return false;
  }
}

async function recordCanaryCheck(
  checks: ValidationPreflightCheck[],
  boundary: ValidationPreflightBoundary,
  canary: () => Promise<ValidationCanaryResult>,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const result = ValidationCanaryResultSchema.parse(await canary());
    const passed = result.status === 'passed' && result.executedModel !== undefined;
    checks.push({
      boundary,
      status: passed ? 'passed' : 'failed',
      durationMs: Date.now() - startedAt,
      ...(passed
        ? {
            provider: result.provider,
            selectedModel: result.selectedModel,
            executedModel: result.executedModel,
          }
        : {
            errorCode: result.executedModel ? 'CANARY_FAILED' : 'UNKNOWN_EXECUTED_MODEL',
            message: `${boundary} did not prove its executed model and output contract.`,
          }),
    });
    return passed;
  } catch {
    checks.push({
      boundary,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: 'CANARY_FAILED',
      message: `${boundary} did not complete.`,
    });
    return false;
  }
}
