import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ValidationCampaignIdSchema, type ValidationCampaignId } from '@agent-foundry/contracts';
import { createTextFileExclusiveSync } from '@agent-foundry/persistence';
import { getDeploymentProfile } from './deployment-profiles.js';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    WEB_ORIGIN: z.string().default('http://localhost:3000'),
    DATA_DIR: z.string().default('.data'),
    HARNESS_DIR: z.string().default('harness'),
    WORKFLOWS_DIR: z.string().default('workflows'),
    POLICIES_DIR: z.string().default('policies'),
    MODEL_CATALOG_PATH: z.string().default('models/catalog.yaml'),
    EXECUTOR_MODE: z.enum(['real', 'mock']).default('mock'),
    VALIDATION_CAMPAIGN: z.preprocess(
      (value) => (value === '' ? undefined : value),
      ValidationCampaignIdSchema.optional(),
    ),
    // Operator-only validation escape hatch for generated apps that redirect
    // the browser to a second loopback service (for example local Supabase).
    // Keep this disabled for normal verification; the browser policy remains
    // deny-by-default unless the operator opts in explicitly.
    ALLOW_LOCAL_BROWSER_REDIRECTS: booleanFromEnv,
    PERSISTENCE_MODE: z.enum(['file', 'postgres']).default('file'),
    DATABASE_URL: z.string().min(1).optional(),
    RUN_WORKER_INLINE: booleanFromEnv,
    AUTO_INSTALL_DEPENDENCIES: booleanFromEnv,
    // How many plan tasks a for-each-task node may run at once, each in its
    // own git worktree (#520). The default is 1 because the constraint is the
    // agent account, not the machine: one ChatGPT login means one shared
    // 5-hour/weekly rate-limit pool, and N parallel Codex sessions drain it N
    // times as fast. Raise it only against an account with known headroom.
    // The ceiling of 8 is the same reasoning — past it the run runs out of
    // rate limit long before it runs out of cores.
    MAX_PARALLEL_TASKS: z.coerce.number().int().min(1).max(8).default(1),
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_200_000),
    SUPABASE_PROVISIONING_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    VERIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    MAX_CLI_OUTPUT_BYTES: z.coerce.number().int().positive().default(20_000_000),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(750),
    CANCEL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    WORKER_ID: z.string().default(`worker-${process.pid}`),
    QUEUE_LEASE_MS: z.coerce.number().int().positive().default(60_000),
    QUEUE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    QUEUE_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
    GIT_AUTHOR_NAME: z.string().default('Agent Foundry'),
    // Git accepts host-only identities; this value is passed to git config, not used as an email address.
    GIT_AUTHOR_EMAIL: z.string().min(1).default('agent-foundry@localhost'),
    PREVIEW_TTL_SECONDS: z.coerce.number().int().positive().default(1_800),
    PREVIEW_STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    PREVIEW_HEALTH_PATH: z.string().startsWith('/').default('/'),
    PREVIEW_HEALTH_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    PREVIEW_HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
    PREVIEW_MAX_RESTARTS: z.coerce.number().int().nonnegative().default(2),
    PREVIEW_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    PREVIEW_LOG_MAX_BYTES: z.coerce.number().int().positive().default(1_000_000),
    ARTIFACT_MAX_SCREENSHOT_BYTES: z.coerce.number().int().positive().default(5_000_000),
    ARTIFACT_MAX_TRACE_BYTES: z.coerce.number().int().positive().default(20_000_000),
    ARTIFACT_MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(50_000_000),
    ARTIFACT_RETENTION_SECONDS: z.coerce.number().int().positive().default(604_800),
    ARTIFACT_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ENVIRONMENT_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ENVIRONMENT_IDLE_MS: z.coerce.number().int().positive().default(1_800_000),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    OTEL_SERVICE_NAME: z.string().optional(),
    OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
    OTEL_SLOW_RUN_THRESHOLD_MS: z.coerce.number().int().positive().default(60_000),
    BLOB_STORE_MODE: z.enum(['fs', 's3']).default('fs'),
    BLOB_SIGNING_SECRET: z.string().min(16).optional(),
    BLOB_GC_GRACE_MS: z.coerce.number().int().positive().default(86_400_000),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanFromEnv,
  })
  .superRefine((parsed, ctx) => {
    if (parsed.VALIDATION_CAMPAIGN && parsed.EXECUTOR_MODE !== 'real') {
      ctx.addIssue({
        code: 'custom',
        path: ['VALIDATION_CAMPAIGN'],
        message: 'VALIDATION_CAMPAIGN requires EXECUTOR_MODE=real',
      });
    }
    if (parsed.BLOB_STORE_MODE !== 's3') return;
    const required = [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const;
    for (const key of required) {
      if (!parsed[key]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when BLOB_STORE_MODE=s3`,
        });
      }
    }
  });

export interface RuntimeConfig {
  environment: 'development' | 'test' | 'production';
  deploymentProfile: string;
  rootDir: string;
  apiHost: string;
  apiPort: number;
  webOrigin: string;
  dataDir: string;
  harnessDir: string;
  workflowsDir: string;
  policiesDir: string;
  modelCatalogPath: string;
  executorMode: 'real' | 'mock';
  validationCampaignId?: ValidationCampaignId;
  allowLocalBrowserRedirects: boolean;
  persistenceMode: 'file' | 'postgres';
  databaseUrl?: string;
  runWorkerInline: boolean;
  autoInstallDependencies: boolean;
  maxParallelTasks: number;
  agentTimeoutMs: number;
  supabaseProvisioningTimeoutMs: number;
  verificationTimeoutMs: number;
  maxCliOutputBytes: number;
  workerPollIntervalMs: number;
  cancelPollIntervalMs: number;
  workerId: string;
  queueLeaseMs: number;
  queueHeartbeatIntervalMs: number;
  queueReapIntervalMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  previewTtlSeconds: number;
  previewStartupTimeoutMs: number;
  previewHealthPath: string;
  previewHealthIntervalMs: number;
  previewHealthFailureThreshold: number;
  previewMaxRestarts: number;
  previewReapIntervalMs: number;
  previewLogMaxBytes: number;
  artifactMaxScreenshotBytes: number;
  artifactMaxTraceBytes: number;
  artifactMaxVideoBytes: number;
  artifactRetentionSeconds: number;
  artifactReapIntervalMs: number;
  environmentReapIntervalMs: number;
  environmentIdleMs: number;
  otelExporterOtlpEndpoint?: string;
  otelServiceName?: string;
  otelTracesSamplerRatio: number;
  otelSlowRunThresholdMs: number;
  blobStoreMode: 'fs' | 's3';
  /** Only set in fs mode (explicit env var, or a derived per-installation secret). */
  blobSigningSecret?: string;
  blobGcGraceMs: number;
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3ForcePathStyle: boolean;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const normalized = {
    ...env,
    API_PORT: env.API_PORT ?? env.PORT,
    WORKER_POLL_INTERVAL_MS: env.WORKER_POLL_INTERVAL_MS ?? env.WORKER_POLL_MS,
    MAX_CLI_OUTPUT_BYTES: env.MAX_CLI_OUTPUT_BYTES ?? env.MAX_AGENT_OUTPUT_BYTES,
    // A custom S3_ENDPOINT means a non-AWS S3-compatible store (MinIO, Supabase
    // Storage, ...), and those all require path-style addressing. Default to it
    // whenever an endpoint is set; an explicit S3_FORCE_PATH_STYLE always wins.
    S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE ?? (env.S3_ENDPOINT ? 'true' : undefined),
  };
  const parsed = ConfigSchema.parse(normalized);
  if (parsed.PERSISTENCE_MODE === 'postgres' && !parsed.DATABASE_URL) {
    throw new Error('PERSISTENCE_MODE=postgres requires DATABASE_URL');
  }
  const rootDir = findRepoRoot(env.REPO_ROOT ?? env.INIT_CWD ?? process.cwd());
  if (!isLoopbackHost(parsed.API_HOST)) {
    throw new Error(
      'Refusing to expose the Agent Foundry control plane on a non-loopback API host. Keep API_HOST on 127.0.0.1, localhost, or ::1.',
    );
  }
  for (const origin of parsed.WEB_ORIGIN.split(',').map((value) => value.trim())) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`WEB_ORIGIN must contain valid loopback HTTP origins: ${origin}`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || !isLoopbackHost(url.hostname)) {
      throw new Error(`Refusing a non-loopback WEB_ORIGIN: ${origin}`);
    }
  }
  const profileSpec = getDeploymentProfile(parsed.EXECUTOR_MODE, parsed.API_HOST, false);
  const deploymentProfile = profileSpec?.name ?? 'custom';
  const dataDir = resolve(rootDir, parsed.DATA_DIR);
  const blobSigningSecret =
    parsed.BLOB_STORE_MODE === 'fs'
      ? (parsed.BLOB_SIGNING_SECRET ?? loadOrCreateBlobSigningSecret(dataDir))
      : undefined;

  return {
    environment: parsed.NODE_ENV,
    deploymentProfile,
    rootDir,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    webOrigin: parsed.WEB_ORIGIN,
    dataDir,
    harnessDir: resolve(rootDir, parsed.HARNESS_DIR),
    workflowsDir: resolve(rootDir, parsed.WORKFLOWS_DIR),
    policiesDir: resolve(rootDir, parsed.POLICIES_DIR),
    modelCatalogPath: resolve(rootDir, parsed.MODEL_CATALOG_PATH),
    executorMode: parsed.EXECUTOR_MODE,
    ...(parsed.VALIDATION_CAMPAIGN ? { validationCampaignId: parsed.VALIDATION_CAMPAIGN } : {}),
    allowLocalBrowserRedirects: parsed.ALLOW_LOCAL_BROWSER_REDIRECTS,
    persistenceMode: parsed.PERSISTENCE_MODE,
    ...(parsed.DATABASE_URL ? { databaseUrl: parsed.DATABASE_URL } : {}),
    runWorkerInline: parsed.RUN_WORKER_INLINE,
    autoInstallDependencies: parsed.AUTO_INSTALL_DEPENDENCIES,
    maxParallelTasks: parsed.MAX_PARALLEL_TASKS,
    agentTimeoutMs: parsed.AGENT_TIMEOUT_MS,
    supabaseProvisioningTimeoutMs: parsed.SUPABASE_PROVISIONING_TIMEOUT_MS,
    verificationTimeoutMs: parsed.VERIFICATION_TIMEOUT_MS,
    maxCliOutputBytes: parsed.MAX_CLI_OUTPUT_BYTES,
    workerPollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    cancelPollIntervalMs: parsed.CANCEL_POLL_INTERVAL_MS,
    workerId: parsed.WORKER_ID,
    queueLeaseMs: parsed.QUEUE_LEASE_MS,
    queueHeartbeatIntervalMs: parsed.QUEUE_HEARTBEAT_INTERVAL_MS,
    queueReapIntervalMs: parsed.QUEUE_REAP_INTERVAL_MS,
    gitAuthorName: parsed.GIT_AUTHOR_NAME,
    gitAuthorEmail: parsed.GIT_AUTHOR_EMAIL,
    previewTtlSeconds: parsed.PREVIEW_TTL_SECONDS,
    previewStartupTimeoutMs: parsed.PREVIEW_STARTUP_TIMEOUT_MS,
    previewHealthPath: parsed.PREVIEW_HEALTH_PATH,
    previewHealthIntervalMs: parsed.PREVIEW_HEALTH_INTERVAL_MS,
    previewHealthFailureThreshold: parsed.PREVIEW_HEALTH_FAILURE_THRESHOLD,
    previewMaxRestarts: parsed.PREVIEW_MAX_RESTARTS,
    previewReapIntervalMs: parsed.PREVIEW_REAP_INTERVAL_MS,
    previewLogMaxBytes: parsed.PREVIEW_LOG_MAX_BYTES,
    artifactMaxScreenshotBytes: parsed.ARTIFACT_MAX_SCREENSHOT_BYTES,
    artifactMaxTraceBytes: parsed.ARTIFACT_MAX_TRACE_BYTES,
    artifactMaxVideoBytes: parsed.ARTIFACT_MAX_VIDEO_BYTES,
    artifactRetentionSeconds: parsed.ARTIFACT_RETENTION_SECONDS,
    artifactReapIntervalMs: parsed.ARTIFACT_REAP_INTERVAL_MS,
    environmentReapIntervalMs: parsed.ENVIRONMENT_REAP_INTERVAL_MS,
    environmentIdleMs: parsed.ENVIRONMENT_IDLE_MS,
    ...(parsed.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined
      ? { otelExporterOtlpEndpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT }
      : {}),
    ...(parsed.OTEL_SERVICE_NAME !== undefined
      ? { otelServiceName: parsed.OTEL_SERVICE_NAME }
      : {}),
    otelTracesSamplerRatio: parsed.OTEL_TRACES_SAMPLER_RATIO,
    otelSlowRunThresholdMs: parsed.OTEL_SLOW_RUN_THRESHOLD_MS,
    blobStoreMode: parsed.BLOB_STORE_MODE,
    ...(blobSigningSecret !== undefined ? { blobSigningSecret } : {}),
    blobGcGraceMs: parsed.BLOB_GC_GRACE_MS,
    ...(parsed.S3_ENDPOINT !== undefined ? { s3Endpoint: parsed.S3_ENDPOINT } : {}),
    ...(parsed.S3_REGION !== undefined ? { s3Region: parsed.S3_REGION } : {}),
    ...(parsed.S3_BUCKET !== undefined ? { s3Bucket: parsed.S3_BUCKET } : {}),
    ...(parsed.S3_ACCESS_KEY_ID !== undefined ? { s3AccessKeyId: parsed.S3_ACCESS_KEY_ID } : {}),
    ...(parsed.S3_SECRET_ACCESS_KEY !== undefined
      ? { s3SecretAccessKey: parsed.S3_SECRET_ACCESS_KEY }
      : {}),
    s3ForcePathStyle: parsed.S3_FORCE_PATH_STYLE,
  };
}

/**
 * fs mode works out of the box without any signing secret configured: the
 * first process to start generates one and persists it under DATA_DIR;
 * every later start (and every other process pointed at the same DATA_DIR)
 * just reads it back.
 *
 * Fast path: every start after the first just reads the file. Only on ENOENT
 * do we generate a candidate secret and race to create it; the create itself
 * is torn-write-safe (temp file + link, see createTextFileExclusiveSync) and
 * falls back to reading whatever a concurrent winner wrote.
 */
function loadOrCreateBlobSigningSecret(dataDir: string): string {
  const path = resolve(dataDir, 'blob-signing-secret');
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const secret = randomBytes(32).toString('hex');
  const created = createTextFileExclusiveSync(path, secret, 0o600);
  return created ? secret : readFileSync(path, 'utf8').trim();
}

export function loadOrCreateInstallationSecret(dataDir: string): string {
  const path = resolve(dataDir, 'installation-secret');
  try {
    return readInstallationSecret(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const candidate = randomBytes(32).toString('hex');
    createTextFileExclusiveSync(path, candidate, 0o600);
    return readInstallationSecret(path);
  }
}

function readInstallationSecret(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Installation secret must be a regular file.');
    const previousMode = before.mode & 0o777;
    if (previousMode !== 0o600) {
      console.warn(
        `[warn] Installation secret permissions were ${previousMode.toString(8).padStart(4, '0')}; repaired to 0600.`,
      );
      fchmodSync(fd, 0o600);
    }
    const secret = readFileSync(fd, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      throw new Error('Installation secret is invalid; refusing to reset it silently.');
    }
    if ((fstatSync(fd).mode & 0o777) !== 0o600) {
      throw new Error('Installation secret permissions must be 0600.');
    }
    return secret;
  } finally {
    closeSync(fd);
  }
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(resolve(current, 'models/catalog.yaml')) &&
      existsSync(resolve(current, 'workflows')) &&
      existsSync(resolve(current, 'harness/manifest.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}
