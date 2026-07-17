import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const ConfigSchema = z.object({
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
});

export interface RuntimeConfig {
  environment: 'development' | 'test' | 'production';
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
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const normalized = {
    ...env,
    API_PORT: env.API_PORT ?? env.PORT,
    WORKER_POLL_INTERVAL_MS: env.WORKER_POLL_INTERVAL_MS ?? env.WORKER_POLL_MS,
    MAX_CLI_OUTPUT_BYTES: env.MAX_CLI_OUTPUT_BYTES ?? env.MAX_AGENT_OUTPUT_BYTES,
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
  return {
    environment: parsed.NODE_ENV,
    rootDir,
    apiHost: parsed.API_HOST,
    apiPort: parsed.API_PORT,
    webOrigin: parsed.WEB_ORIGIN,
    dataDir: resolve(rootDir, parsed.DATA_DIR),
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
  };
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
