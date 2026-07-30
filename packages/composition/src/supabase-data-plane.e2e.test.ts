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
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresJobQueue, createPostgresClient, migrateUp } from '@agent-foundry/persistence';
import { approveAllGates } from './testing-helpers.js';
import { createRuntime, type Runtime } from './runtime.js';
import {
  allocateLocalSupabasePorts,
  assertMigrationCapableDatabaseUrl,
  buildLocalSupabaseConfig,
  hostedSupabaseDataPlaneConfigFromEnv,
  localSupabaseDataPlaneConfigFromStatusEnv,
  runCleanupSteps,
  isMissingS3ResourceError,
  type SupabaseDataPlaneConfig,
} from './supabase-data-plane.e2e-support.js';

const execFileAsync = promisify(execFile);
const SHOULD_RUN = process.env.RUN_SUPABASE_DATA_PLANE_E2E === 'true';
const USE_HOSTED = process.env.SUPABASE_DATA_PLANE_USE_HOSTED === 'true';
const START_TIMEOUT_MS = 5 * 60 * 1_000;
const STOP_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const FULL_SUITE_TIMEOUT_MS = 10 * 60_000;
const rootDir = resolve(import.meta.dirname, '../../..');

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
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    runtimeDataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-supabase-data-plane-'));
    cleanupPaths.add(runtimeDataDir);
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
    try {
      await runCleanupSteps([
        ...Array.from(createdBlobKeys, (key) => ({
          label: `delete object ${key}`,
          run: async () => {
            if (!runtime) return;
            await runtime.blobStore.delete(key);
          },
        })),
        {
          label: 'delete remaining Supabase S3 objects',
          run: async () => {
            if (!s3 || !bucket) return;
            let continuationToken: string | undefined;
            do {
              const page = await s3.send(
                new ListObjectsV2Command({
                  Bucket: bucket,
                  ContinuationToken: continuationToken,
                }),
              );
              for (const object of page.Contents ?? []) {
                if (!object.Key) continue;
                await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
              }
              continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
            } while (continuationToken);
          },
        },
        {
          label: `delete bucket ${bucket ?? '<none>'}`,
          run: async () => {
            if (!s3 || !bucket) return;
            try {
              await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
            } catch (error) {
              if (!isMissingS3ResourceError(error)) throw error;
            }
          },
        },
        {
          label: 'stop local supabase stack',
          run: async () => {
            if (!localSupabaseDir) return;
            await execFileAsync(
              'supabase',
              ['stop', '--workdir', localSupabaseDir, '--no-backup', '--yes'],
              {
                encoding: 'utf8',
                timeout: STOP_TIMEOUT_MS,
              },
            );
          },
        },
        ...Array.from(cleanupPaths, (path) => ({
          label: `remove temp path ${path}`,
          run: async () => {
            await rm(path, { recursive: true, force: true });
          },
        })),
      ]);
    } finally {
      s3?.destroy();
    }
  }, STOP_TIMEOUT_MS + 10_000);

  it(
    'becomes ready, completes a representative Postgres-backed workflow run, and round-trips direct blob-store bytes through Supabase S3',
    async () => {
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
        sizeBytes: payload.byteLength,
      });
      // Supabase may normalize the media type with a UTF-8 charset parameter.
      expect(stat?.contentType).toMatch(/^text\/plain(?:;|$)/);

      const signedUrl = await runtime.blobStore.createSignedDownloadUrl(blobKey, 60);
      const response = await fetch(signedUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      expect(response.ok).toBe(true);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);

      if (!USE_HOSTED) {
        await runLocalSupabaseAcceptanceSuites(config, bucket);
      }
    },
    FULL_SUITE_TIMEOUT_MS,
  );

  async function runLocalSupabaseAcceptanceSuites(
    dataPlaneConfig: SupabaseDataPlaneConfig,
    dataPlaneBucket: string,
  ): Promise<void> {
    const sharedEnv = {
      ...process.env,
      PERSISTENCE_MODE: 'postgres',
      BLOB_STORE_MODE: 's3',
      DATABASE_URL: dataPlaneConfig.databaseUrl,
      S3_ENDPOINT: dataPlaneConfig.s3Endpoint,
      S3_REGION: dataPlaneConfig.s3Region,
      S3_BUCKET: dataPlaneBucket,
      S3_ACCESS_KEY_ID: dataPlaneConfig.s3AccessKeyId,
      S3_SECRET_ACCESS_KEY: dataPlaneConfig.s3SecretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
      AUTO_INSTALL_DEPENDENCIES: 'false',
    };

    await resetDatabase(dataPlaneConfig.databaseUrl);
    await runAcceptanceCommand(
      'golden-flow e2e',
      'npx',
      ['playwright', 'test', '--config', 'e2e/playwright.config.ts', 'e2e/golden-flow.spec.ts'],
      sharedEnv,
      join(rootDir, 'apps/api'),
    );
    await resetDatabase(dataPlaneConfig.databaseUrl);
    await runAcceptanceCommand(
      'Postgres persistence suites',
      'npx',
      ['vitest', 'run', 'packages/persistence/src/postgres', '--pool=threads', '--maxWorkers=1'],
      { ...sharedEnv, SUPABASE_TEST_DATABASE_URL: dataPlaneConfig.databaseUrl },
      rootDir,
    );
  }

  async function resetDatabase(databaseUrl: string): Promise<void> {
    const sql = createPostgresClient(databaseUrl);
    try {
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'schema_migrations'`;
      if (tables.length > 0) {
        await sql.unsafe(
          `truncate table ${tables.map((table) => `"${table.table_name}"`).join(', ')} cascade`,
        );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function runAcceptanceCommand(
    label: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<void> {
    try {
      const result = await execFileAsync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        timeout: FULL_SUITE_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
      });
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      throw new Error(`${label} failed.\n${failed.stdout ?? ''}\n${failed.stderr ?? ''}`, {
        cause: error,
      });
    }
  }

  async function startLocalSupabaseProject(): Promise<SupabaseDataPlaneConfig> {
    localSupabaseDir = await mkdtemp(join(tmpdir(), 'agent-foundry-supabase-project-'));
    cleanupPaths.add(localSupabaseDir);
    const projectId = `af232_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const ports = await allocateLocalSupabasePorts(projectId, isPortFree);
    await mkdir(join(localSupabaseDir, 'supabase', 'migrations'), { recursive: true });
    await writeFile(join(localSupabaseDir, 'supabase', 'config.toml'), buildLocalSupabaseConfig());
    await writeFile(
      join(localSupabaseDir, '.env'),
      [`SUPABASE_PROJECT_ID=${projectId}`]
        .concat(Object.entries(ports).map(([key, value]) => `${key}=${value}`))
        .join('\n'),
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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
