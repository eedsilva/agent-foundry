import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execa } from 'execa';
import {
  PathSegmentSchema,
  ValidationCanaryResultSchema,
  ValidationPreflightReportSchema,
  type ValidationCanaryResult,
  type ValidationPreflightBoundary,
  type ValidationPreflightCheck,
  type ValidationPreflightReport,
  type ValidationPreflightStatus,
  type ValidationCampaignPreview,
  type EnvironmentIdentity,
  type PreviewSession,
  type PreviewWorkspaceRef,
} from '@agent-foundry/contracts';
import {
  redactPersonalPaths,
  redactString,
  redactValidationPreflightReport,
  type GeneratedProjectRuntime,
  type HarnessRepository,
  type PreviewRunner,
  type WorkspaceManager,
} from '@agent-foundry/domain';
import {
  runReproducibleInstall,
  resolvePreviewCommandPlan,
  safeSpawnEnv,
} from '@agent-foundry/executors';
import type { PreviewService } from '@agent-foundry/orchestrator';
import {
  createValidationCampaignCanaryDependencies,
  runValidationCampaignCanary,
  type ValidationCanaryDependencies,
} from './provider-canary.js';

/** The preflight environment (#617). It is disposable and has no ledger
 * entry, which is exactly the Manual Preview Stack binding: recreated when the
 * SQL it was built from changes. The digest covers the scaffold's own
 * `supabase/` files, so the day the scaffold gains a migration the stack stops
 * being addressed as the same environment. Naming it explicitly is what keeps
 * this caller off the legacy single-environment root. */
const PREFLIGHT_ENVIRONMENT_ID = 'preflight';

function preflightIdentity(
  projectId: string,
  scaffold: Array<{ path: string; content: string }>,
): EnvironmentIdentity {
  const digest = createHash('sha256');
  for (const file of scaffold
    .filter((file) => file.path.startsWith('supabase/'))
    .sort((a, b) => a.path.localeCompare(b.path))) {
    digest.update(`${file.path}\u0000${file.content}\u0000`);
  }
  return {
    class: 'manual-preview',
    projectId,
    environmentId: PREFLIGHT_ENVIRONMENT_ID,
    migrationDigest: digest.digest('hex'),
  };
}

export interface ValidationPreflightChecks {
  disposableEnvironment(): Promise<void>;
  docker(): Promise<void>;
  supabase(): Promise<void>;
  scaffold(): Promise<void>;
  applicationHealth(): Promise<void>;
  previewGateway(): Promise<void>;
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

export async function runValidationPreflight(
  options: ValidationPreflightOptions,
): Promise<ValidationPreflightReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const checks: ValidationPreflightCheck[] = [];
  let status: ValidationPreflightStatus = 'passed';
  let report: ValidationPreflightReport | undefined;
  let cleanupFailed = false;
  let cleanupCause = '';
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
    } catch (error) {
      cleanupFailed = true;
      cleanupCause = describeCause(error);
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
          message: `Disposable preflight resources could not be cleaned up. ${cleanupCause}`,
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
  // Resolved once and reused by every later call, so health, preview
  // credentials and cleanup all address the environment initialize() actually
  // created (#617).
  let scaffoldFiles: Array<{ path: string; content: string }> | undefined;
  const scaffold = async () => (scaffoldFiles ??= await options.harness.scaffoldFiles('nextjs'));
  const target = () => ({
    projectId: options.environmentId,
    environmentId: PREFLIGHT_ENVIRONMENT_ID,
  });
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
      if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error(`Docker is not ready. ${failureDetail(result.stderr, result.stdout)}`);
      }
    },
    async supabase() {
      if (!options.generatedProjectRuntime) throw new Error('Supabase runtime is unavailable.');
      await options.generatedProjectRuntime.initialize({
        projectId: options.environmentId,
        identity: preflightIdentity(options.environmentId, await scaffold()),
      });
      environmentInitialized = true;
      const environment = await options.generatedProjectRuntime.health(target());
      if (environment.health.state !== 'healthy') {
        throw new Error(`Supabase is not healthy. state=${environment.health.state}`);
      }
    },
    async scaffold() {
      await options.workspaces.ensure(options.environmentId);
      workspaceCreated = true;
      await options.workspaces.applyScaffold(options.environmentId, await scaffold());
      const workspacePath = options.workspaces.workspacePath(options.environmentId);
      const plan = await resolvePreviewCommandPlan(workspacePath);
      if (!plan.build.ok) throw new Error(plan.build.reason);
      const install = await runReproducibleInstall(plan, workspacePath, {
        timeoutMs: options.installTimeoutMs ?? 120_000,
        maxOutputBytes: options.maxOutputBytes,
      });
      if (!install.ok) {
        throw new Error(
          `Scaffold install failed. ${failureDetail(install.stderr, install.stdout)}`,
        );
      }
      // The generated app builds under its own environment, not the
      // orchestrator's: execa extends process.env by default, which both hands
      // the app every foundry secret and leaks NODE_ENV=development into a
      // production build — React then resolves its dev bundle inside the
      // prerender worker and `next build` dies on a null internal.
      const build = await execa(plan.build.command, plan.build.args, {
        cwd: workspacePath,
        reject: false,
        timeout: options.installTimeoutMs ?? 120_000,
        maxBuffer: options.maxOutputBytes,
        ...safeSpawnEnv(process.env, { NODE_ENV: 'production' }),
      });
      if (build.exitCode !== 0) {
        throw new Error(`Scaffold build failed. ${failureDetail(build.stderr, build.stdout)}`);
      }
      preview = await options.previews.start({
        workspaceRef: {
          ...target(),
          workspacePath,
        } satisfies PreviewWorkspaceRef,
      });
      if (preview.session.status !== 'running' || !preview.url) {
        throw new Error(`Scaffold preview did not start. status=${preview.session.status}`);
      }
    },
    async applicationHealth() {
      if (!preview) throw new Error('Scaffold preview is unavailable.');
      const health = await options.previewRunner.health(preview.session);
      if (health.state !== 'healthy') {
        throw new Error(`Generated application is not healthy. state=${health.state}`);
      }
    },
    async previewGateway() {
      if (!preview) throw new Error('Preview gateway is unavailable.');
      // Don't follow redirects: the gateway authorizes the first request by its
      // `?token=` query and hands the caller a `pv_<sessionId>` cookie for the
      // rest, and fetch keeps no cookie jar. The scaffold's auth middleware
      // redirects `/` to `/sign-in`, so a followed redirect arrives with no
      // credential at all and the proxy denies it — reading as a broken gateway
      // when the gateway is exactly what just worked. Any non-error status is
      // proof the proxy resolved the session and reached the app.
      const response = await fetch(preview.url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status >= 400) {
        throw new Error(
          `Preview gateway returned a non-success response. status=${response.status}`,
        );
      }
    },
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
      // Labelled so a leak names the resource that survived — an unlabelled
      // "cleanup failed" leaves the operator diffing `docker ps` by hand.
      const labelled = (name: string, task: Promise<unknown>) =>
        task.catch((error: unknown) => {
          throw new Error(`${name} teardown failed: ${causeText(error)}`);
        });

      // Workspace removal goes last and alone: it deletes the whole project
      // root, and the Supabase stack lives under it — `supabase stop --workdir`
      // needs that directory to still exist. Run concurrently, the rm wins the
      // race and every failed preflight strands a ten-container stack that
      // restart=always then revives on each Docker boot.
      const stopped = await Promise.allSettled([
        labelled(
          'preview',
          preview ? options.previews.stop(preview.session.id) : Promise.resolve(),
        ),
        labelled(
          'supabase',
          environmentInitialized && options.generatedProjectRuntime
            ? options.generatedProjectRuntime.cleanup({
                ...target(),
                confirmation: {
                  confirmed: true,
                  backupCreatedAt: new Date(Date.now() - 1_000).toISOString(),
                },
              })
            : Promise.resolve(),
        ),
      ]);
      const removed = await Promise.allSettled([
        labelled(
          'workspace',
          workspaceCreated ? options.workspaces.cleanup(options.environmentId) : Promise.resolve(),
        ),
      ]);
      const failures = [...stopped, ...removed].flatMap((result) =>
        result.status === 'rejected' ? [causeText(result.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(failures.join('; '));
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
  } catch (error) {
    checks.push({
      boundary,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: 'PREFLIGHT_FAILED',
      message: `${boundary} prerequisite failed. ${describeCause(error)}`,
    });
    return false;
  }
}

/** Keeps a stdout dump from landing in the bundle when a tool floods stderr. */
const MAX_CAUSE_CHARS = 500;

/** Leaves room for the boundary prefix inside MAX_CAUSE_CHARS. */
const MAX_DETAIL_CHARS = 300;

/**
 * Build tools put the diagnosis at the end of stderr, so keep the tail — without
 * it the boundary throws a fixed string and describeCause has nothing to carry.
 * Task runners like pnpm report a failing child script on stdout and leave
 * stderr empty, so take the first stream that carries anything: a stderr-only
 * reading turns those failures into "No output." Redact the whole stream before
 * cutting: slicing raw output can start mid-token and hand the cap a key whose
 * prefix — the only thing VALUE_PATTERNS matches on — was left behind on the
 * other side of the cut.
 */
export function failureDetail(...streams: Array<string | undefined>): string {
  for (const stream of streams) {
    if (!stream) continue;
    const detail = redactPersonalPaths(redactString(stream)).trim().slice(-MAX_DETAIL_CHARS);
    if (detail) return detail;
  }
  return 'No output.';
}

function causeText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Evidence must be redacted, not empty: a bare boundary name leaves the
 * operator re-running the gate by hand to learn what broke. Every raw error
 * that enters a report passes here first; the publisher scrubs again on the
 * way out. Redact before truncating, so no half-scrubbed secret survives the
 * cap.
 */
function describeCause(error: unknown): string {
  const redacted = redactPersonalPaths(redactString(causeText(error))).trim();
  if (redacted === '') return 'No cause reported.';
  return redacted.length > MAX_CAUSE_CHARS ? `${redacted.slice(0, MAX_CAUSE_CHARS)}…` : redacted;
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
    const errorCode = PathSegmentSchema.safeParse(result.error?.code);
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
            errorCode:
              (errorCode.success ? errorCode.data : undefined) ??
              (result.executedModel ? 'CANARY_FAILED' : 'UNKNOWN_EXECUTED_MODEL'),
            // The canary fails without throwing, so its own classification is
            // the only account of the cause that ever reaches this report.
            message:
              `${boundary} did not prove its executed model and output contract. status=${result.status} executedModel=${result.executedModel ?? 'missing'}` +
              (result.error ? ` ${result.error.kind}: ${describeCause(result.error.message)}` : ''),
          }),
    });
    return passed;
  } catch (error) {
    checks.push({
      boundary,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: 'CANARY_FAILED',
      message: `${boundary} did not complete. ${describeCause(error)}`,
    });
    return false;
  }
}
