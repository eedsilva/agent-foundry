import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createPostgresClient,
  migrateDown,
  migrateUp,
  type PostgresDb,
} from '@agent-foundry/persistence';
import { createRuntime, type Runtime } from './runtime.js';

// ponytail: duplicates the Docker-skip guard from persistence/src/postgres/testing.ts instead of
// exporting `describePostgres` through the package barrel. Exporting it would pull
// @testcontainers/postgresql into the production bundle of every consumer (api, worker) built
// from `@agent-foundry/persistence`'s single index.ts entry point. Promote to a shared
// test-utils export if a third package ever needs the same guard.
function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = probeDocker();
if (process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for Postgres composition tests; refusing to skip.');
}
const maybeDescribe = dockerAvailable ? describe : describe.skip;

const rootDir = resolve(import.meta.dirname, '../../..');

async function approveDiffGate(runtime: Runtime, runId: string): Promise<void> {
  const [diffApproval] = (await runtime.projectService.listApprovals(runId)).filter(
    (entry) => entry.request.nodeId === 'diff-approval',
  );
  if (!diffApproval) throw new Error('Expected a pending diff-approval request');
  await runtime.projectService.decideApproval(runId, diffApproval.request.id, {
    action: 'approve',
    decidedBy: 'postgres-composition-test',
  });
}

it('rejects PERSISTENCE_MODE=postgres without DATABASE_URL', async () => {
  await expect(
    createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      PERSISTENCE_MODE: 'postgres',
      DATABASE_URL: undefined,
      EXECUTOR_MODE: 'mock',
    }),
  ).rejects.toThrow(/PERSISTENCE_MODE=postgres requires DATABASE_URL/);
});

maybeDescribe('Postgres-backed runtime', () => {
  let sql: PostgresDb;
  let stop: (() => Promise<unknown>) | undefined;
  let databaseUrl: string;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer('postgres:17-alpine').start();
    stop = () => container.stop();
    databaseUrl = container.getConnectionUri();
    sql = createPostgresClient(databaseUrl);
    await migrateUp(sql);
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await stop?.();
  }, 60_000);

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('boots, round-trips a project through Postgres, and drives a mock run to completion', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-postgres-runtime-'));
    temporaryDirectories.push(dataDir);
    const runtime = await createRuntime({
      ...process.env,
      REPO_ROOT: rootDir,
      DATA_DIR: dataDir,
      PERSISTENCE_MODE: 'postgres',
      DATABASE_URL: databaseUrl,
      EXECUTOR_MODE: 'mock',
      AUTO_INSTALL_DEPENDENCIES: 'false',
      WORKER_ID: 'postgres-runtime-worker',
    });

    const project = await runtime.projectService.create({
      name: 'Postgres runtime sample',
      workflowId: 'web-app-v1',
      prd: 'Build a small persistent issue tracker with validation and deterministic tests.',
    });
    expect(await runtime.projects.get(project.id)).toMatchObject({ id: project.id });

    if (!project.currentRunId) {
      throw new Error('Expected project to reference its workflow run');
    }
    const runId = project.currentRunId;

    expect(await runtime.worker.runOnce()).toBe(true);
    await approveDiffGate(runtime, runId);
    expect(await runtime.worker.runOnce()).toBe(true);

    const detail = await runtime.projectService.get(project.id);
    expect(detail.project.status).toBe('completed');
    expect(await runtime.runs.get(runId)).toMatchObject({
      status: 'completed',
      projectId: project.id,
    });
  }, 30_000);

  it('fails fast when the schema is behind, and recovers after migrating up', async () => {
    await migrateDown(sql, 0);
    try {
      await expect(
        createRuntime({
          ...process.env,
          REPO_ROOT: rootDir,
          PERSISTENCE_MODE: 'postgres',
          DATABASE_URL: databaseUrl,
          EXECUTOR_MODE: 'mock',
        }),
      ).rejects.toThrow(/db:migrate/);
    } finally {
      await migrateUp(sql);
    }
  }, 30_000);
});
