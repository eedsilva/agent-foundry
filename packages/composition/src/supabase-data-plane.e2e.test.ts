import { execFile, execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJobQueue, createPostgresClient, migrateUp } from '@agent-foundry/persistence';
import { approveAllGates } from './testing-helpers.js';
import { createRuntime, type Runtime } from './runtime.js';
import {
  assertMigrationCapableDatabaseUrl,
  hostedSupabaseDataPlaneConfigFromEnv,
  localSupabaseDataPlaneConfigFromStatusEnv,
  type SupabaseDataPlaneConfig,
} from './supabase-data-plane.e2e-support.js';

const execFileAsync = promisify(execFile);
const SHOULD_RUN = process.env.RUN_SUPABASE_DATA_PLANE_E2E === 'true';
const USE_HOSTED = process.env.SUPABASE_DATA_PLANE_USE_HOSTED === 'true';
const START_TIMEOUT_MS = 5 * 60 * 1_000;
const STOP_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const rootDir = resolve(import.meta.dirname, '../../..');
const TEMP_SUPABASE_CONFIG = `project_id = "env(SUPABASE_PROJECT_ID)"

[api]
port = "env(SUPABASE_API_PORT)"

[db]
port = "env(SUPABASE_DB_PORT)"
shadow_port = "env(SUPABASE_DB_SHADOW_PORT)"
major_version = 17

[db.migrations]
enabled = false

[db.seed]
enabled = false

[studio]
port = "env(SUPABASE_STUDIO_PORT)"

[analytics]
enabled = false

[inbucket]
enabled = false

[realtime]
enabled = false

[edge_runtime]
enabled = false
`;

function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = probeDocker();
if (SHOULD_RUN && !USE_HOSTED && process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for the Supabase data-plane acceptance test.');
}
const suite = !SHOULD_RUN
  ? describe.skip
  : USE_HOSTED || dockerAvailable
    ? describe
    : describe.skip;

suite('Supabase Postgres + Storage data plane', () => {
  let runtime: Runtime | undefined;
  let config: SupabaseDataPlaneConfig | undefined;
  let runtimeDataDir: string | undefined;
  let localSupabaseDir: string | undefined;
  let bucket: string | undefined;
  let s3: S3Client | undefined;
  const createdBlobKeys = new Set<string>();

  beforeAll(async () => {
    runtimeDataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-supabase-data-plane-'));
    config = USE_HOSTED
      ? hostedSupabaseDataPlaneConfigFromEnv(process.env)
      : await startLocalSupabaseProject();
    assertMigrationCapableDatabaseUrl(config.databaseUrl);

    const migrationSql = createPostgresClient(config.databaseUrl);
    try {
      await migrateUp(migrationSql);
    } finally {
      await migrationSql.end({ timeout: 5 });
    }

    bucket = `agent-foundry-e2e-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    s3 = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.s3AccessKeyId,
        secretAccessKey: config.s3SecretAccessKey,
      },
    });
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: runtimeDataDir,
      PERSISTENCE_MODE: 'postgres',
      DATABASE_URL: config.databaseUrl,
      BLOB_STORE_MODE: 's3',
      S3_ENDPOINT: config.s3Endpoint,
      S3_REGION: config.s3Region,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: config.s3AccessKeyId,
      S3_SECRET_ACCESS_KEY: config.s3SecretAccessKey,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'supabase-data-plane-worker',
    });
  }, START_TIMEOUT_MS);

  afterAll(async () => {
    for (const key of createdBlobKeys) {
      await s3?.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    }
    if (bucket) {
      await s3?.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    }
    s3?.destroy();
    if (localSupabaseDir) {
      await execFileAsync(
        'supabase',
        ['stop', '--workdir', localSupabaseDir, '--no-backup', '--yes'],
        {
          encoding: 'utf8',
          timeout: STOP_TIMEOUT_MS,
        },
      ).catch(() => undefined);
    }
    await Promise.all(
      [runtimeDataDir, localSupabaseDir]
        .filter((path): path is string => Boolean(path))
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  }, STOP_TIMEOUT_MS + 10_000);

  it('becomes ready, completes a representative Postgres-backed workflow run, and round-trips blob bytes through Supabase S3', async () => {
    if (!runtime || !config || !bucket) {
      throw new Error('Expected Supabase data-plane runtime to be initialized.');
    }

    expect(runtime.config.persistenceMode).toBe('postgres');
    expect(runtime.config.blobStoreMode).toBe('s3');
    expect(runtime.queue).toBeInstanceOf(PostgresJobQueue);
    await expect(runtime.checkReadiness()).resolves.toBeUndefined();

    const project = await runtime.projectService.create({
      name: 'Supabase data-plane sample',
      workflowId: 'web-app-v1',
      prd: 'Build a small persistent issue tracker with deterministic tests.',
    });
    if (!project.currentRunId) {
      throw new Error('Expected project to reference its workflow run.');
    }

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveAllGates(runtime, project.currentRunId, 'supabase-data-plane-test');

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(await runtime.runs.get(project.currentRunId)).toMatchObject({
      status: 'completed',
      projectId: project.id,
    });

    const blobKey = `projects/${project.id}/validation/blob.txt`;
    createdBlobKeys.add(blobKey);
    const payload = Buffer.from('supabase data plane blob payload');
    const stored = await runtime.blobStore.put(
      {
        key: blobKey,
        contentType: 'text/plain',
        maxBytes: 1_024,
      },
      Readable.from(payload),
    );
    expect(stored).toMatchObject({
      key: blobKey,
      contentType: 'text/plain',
      sizeBytes: payload.byteLength,
    });

    const stat = await runtime.blobStore.stat(blobKey);
    expect(stat).toMatchObject({
      key: blobKey,
      contentType: 'text/plain',
      sizeBytes: payload.byteLength,
    });

    const signedUrl = await runtime.blobStore.createSignedDownloadUrl(blobKey, 60);
    const response = await fetch(signedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    expect(response.ok).toBe(true);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
  }, 120_000);

  async function startLocalSupabaseProject(): Promise<SupabaseDataPlaneConfig> {
    localSupabaseDir = await mkdtemp(join(tmpdir(), 'agent-foundry-supabase-project-'));
    const ports = await allocatePorts();
    await mkdir(join(localSupabaseDir, 'supabase', 'migrations'), { recursive: true });
    await writeFile(join(localSupabaseDir, 'supabase', 'config.toml'), TEMP_SUPABASE_CONFIG);
    await writeFile(
      join(localSupabaseDir, '.env'),
      [
        `SUPABASE_PROJECT_ID=af232_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
        `SUPABASE_API_PORT=${ports.api}`,
        `SUPABASE_DB_PORT=${ports.db}`,
        `SUPABASE_DB_SHADOW_PORT=${ports.shadowDb}`,
        `SUPABASE_STUDIO_PORT=${ports.studio}`,
      ].join('\n'),
    );

    await execFileAsync('supabase', ['start', '--workdir', localSupabaseDir, '--yes'], {
      encoding: 'utf8',
      timeout: START_TIMEOUT_MS,
    });
    const { stdout } = await execFileAsync(
      'supabase',
      ['status', '--workdir', localSupabaseDir, '--output', 'env'],
      {
        encoding: 'utf8',
        timeout: STOP_TIMEOUT_MS,
      },
    );
    return localSupabaseDataPlaneConfigFromStatusEnv(stdout);
  }
});

async function allocatePorts(): Promise<{
  api: number;
  db: number;
  shadowDb: number;
  studio: number;
}> {
  const api = await findFreePort(55_321);
  const db = await findFreePort(api + 1);
  const shadowDb = await findFreePort(db + 1);
  const studio = await findFreePort(shadowDb + 1);
  return { api, db, shadowDb, studio };
}

async function findFreePort(start: number): Promise<number> {
  for (let port = start; port <= 65_000; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found starting at ${start}.`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
