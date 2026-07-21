import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
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
    RUN_WORKER_INLINE: booleanFromEnv,
    AUTO_INSTALL_DEPENDENCIES: booleanFromEnv,
    ALLOW_UNSAFE_REMOTE_REAL_EXECUTION: booleanFromEnv,
    AGENT_TIMEOUT_MS: z.coerce.number().int().positive().default(1_200_000),
    VERIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
    MAX_CLI_OUTPUT_BYTES: z.coerce.number().int().positive().default(20_000_000),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(750),
    CANCEL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
    WORKER_ID: z.string().default(`worker-${process.pid}`),
    QUEUE_LEASE_MS: z.coerce.number().int().positive().default(60_000),
    QUEUE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    QUEUE_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(20_000),
    GIT_AUTHOR_NAME: z.string().default('Agent Foundry'),
    GIT_AUTHOR_EMAIL: z.string().email().default('agent-foundry@localhost'),
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
  runWorkerInline: boolean;
  autoInstallDependencies: boolean;
  allowUnsafeRemoteRealExecution: boolean;
  agentTimeoutMs: number;
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
  const rootDir = findRepoRoot(env.REPO_ROOT ?? env.INIT_CWD ?? process.cwd());
  if (
    parsed.EXECUTOR_MODE === 'real' &&
    !isLoopbackHost(parsed.API_HOST) &&
    !parsed.ALLOW_UNSAFE_REMOTE_REAL_EXECUTION
  ) {
    throw new Error(
      'Refusing to expose real CLI execution on a non-loopback API host. Keep API_HOST on 127.0.0.1/localhost or explicitly set ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true after accepting the host-level risk.',
    );
  }
  const profileSpec = getDeploymentProfile(
    parsed.EXECUTOR_MODE,
    parsed.API_HOST,
    parsed.ALLOW_UNSAFE_REMOTE_REAL_EXECUTION,
  );
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
    runWorkerInline: parsed.RUN_WORKER_INLINE,
    autoInstallDependencies: parsed.AUTO_INSTALL_DEPENDENCIES,
    allowUnsafeRemoteRealExecution: parsed.ALLOW_UNSAFE_REMOTE_REAL_EXECUTION,
    agentTimeoutMs: parsed.AGENT_TIMEOUT_MS,
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
