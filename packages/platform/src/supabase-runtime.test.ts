import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentOperationError } from '@agent-foundry/domain';
import { SupabaseGeneratedProjectRuntime, type SupabaseCommand } from './supabase-runtime.js';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const STATUS = JSON.stringify({
  API_URL: 'http://127.0.0.1:54321',
  GRAPHQL_URL: 'http://127.0.0.1:54321/graphql/v1',
  STUDIO_URL: 'http://127.0.0.1:54323',
  INBUCKET_URL: 'http://127.0.0.1:54324',
  DB_URL: 'postgresql://postgres:db-secret@127.0.0.1:54322/postgres',
  JWT_SECRET: 'jwt-secret',
  ANON_KEY: 'anon-secret',
});

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-platform-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function statusCommand(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return Promise.resolve({ stdout: STATUS, stderr: '', exitCode: 0 });
}

function fixture(command = vi.fn<SupabaseCommand>(statusCommand)) {
  return {
    command,
    runtime: new SupabaseGeneratedProjectRuntime({
      dataDir,
      command,
      now: () => new Date(NOW),
    }),
  };
}

describe('SupabaseGeneratedProjectRuntime', () => {
  it('initializes projects with isolated CLI workdirs, networks, and secret-free metadata', async () => {
    const { command, runtime } = fixture();

    const [first, second] = await Promise.all([
      runtime.initialize({ projectId: 'project-a' }),
      runtime.initialize({ projectId: 'project-b' }),
    ]);

    expect(first.workdir).not.toBe(second.workdir);
    expect(first.network).not.toBe(second.network);
    expect(command.mock.calls).toContainEqual(['init', '--workdir', first.workdir]);
    expect(command.mock.calls).toContainEqual([
      'start',
      '--workdir',
      first.workdir,
      '--output',
      'json',
      '--yes',
      '--network-id',
      first.network,
    ]);
    expect(first).toMatchObject({
      projectId: 'project-a',
      endpoints: {
        api: 'http://127.0.0.1:54321',
        graphql: 'http://127.0.0.1:54321/graphql/v1',
        studio: 'http://127.0.0.1:54323',
        mail: 'http://127.0.0.1:54324',
      },
      ports: { api: 54321, graphql: 54321, studio: 54323, mail: 54324 },
      health: { state: 'healthy', checkedAt: NOW.toISOString() },
    });
    const metadata = await readFile(join(first.workdir, 'environment.json'), 'utf8');
    expect(metadata).not.toMatch(/db-secret|jwt-secret|anon-secret|DB_URL|JWT_SECRET|ANON_KEY/);
  });

  it('does not initialize or start Supabase twice for the same project', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });

    await expect(runtime.initialize({ projectId: 'project-a' })).resolves.toEqual(environment);
    await expect(runtime.inspect('project-a')).resolves.toEqual(environment);

    expect(command.mock.calls.filter(([name]) => name === 'init')).toHaveLength(1);
    expect(command.mock.calls.filter(([name]) => name === 'start')).toHaveLength(1);
    expect(command.mock.calls).toContainEqual([
      'status',
      '--workdir',
      environment.workdir,
      '--output',
      'json',
    ]);
  });

  it('makes stop and restart idempotent while preserving exact lifecycle commands', async () => {
    const { command, runtime } = fixture();
    const initialized = await runtime.initialize({ projectId: 'project-a' });

    const stopped = await runtime.stop('project-a');
    await runtime.stop('project-a');
    const restarted = await runtime.start('project-a');
    await runtime.start('project-a');

    expect(stopped.health.state).toBe('stopped');
    expect(restarted.health.state).toBe('healthy');
    expect(command.mock.calls.filter(([name]) => name === 'stop')).toEqual([
      ['stop', '--workdir', initialized.workdir],
    ]);
    expect(command.mock.calls.filter(([name]) => name === 'start')).toHaveLength(2);
  });

  it('uses status for inspect and health while ignoring credential-bearing status fields', async () => {
    const { command, runtime } = fixture();
    const initialized = await runtime.initialize({ projectId: 'project-a' });
    command.mockClear();

    const inspected = await runtime.inspect('project-a');
    const health = await runtime.health('project-a');

    expect(inspected?.endpoints).toEqual(initialized.endpoints);
    expect(JSON.stringify(inspected)).not.toContain('db-secret');
    expect(health.health.state).toBe('healthy');
    expect(command.mock.calls).toEqual([
      ['status', '--workdir', initialized.workdir, '--output', 'json'],
      ['status', '--workdir', initialized.workdir, '--output', 'json'],
    ]);
    await expect(runtime.inspect('missing')).resolves.toBeNull();
  });

  it('runs local migration and seed commands only for paths contained by the project workdir', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    await writeFile(join(environment.workdir, 'migration.sql'), 'select 1;');
    await writeFile(join(environment.workdir, 'seed.sql'), 'select 1;');
    command.mockClear();

    await runtime.migrate({ projectId: 'project-a', migrationPath: 'migration.sql' });
    await runtime.seed({ projectId: 'project-a', seedPath: 'seed.sql' });

    expect(command.mock.calls).toEqual([
      ['migration', 'up', '--workdir', environment.workdir, '--yes'],
      ['seed', '--workdir', environment.workdir, '--yes'],
    ]);
    await expect(
      runtime.migrate({ projectId: 'project-a', migrationPath: '../outside.sql' }),
    ).rejects.toThrow(/inside the project environment/);
    await expect(
      runtime.seed({ projectId: 'project-a', seedPath: join(dataDir, 'outside.sql') }),
    ).rejects.toThrow(/relative path/);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('gates reset on explicit confirmation and a backup from the last 24 hours', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    command.mockClear();

    await expect(
      runtime.reset({ projectId: 'project-a', confirmation: { confirmed: false } }),
    ).rejects.toThrow(/confirmation/);
    await expect(
      runtime.reset({ projectId: 'project-a', confirmation: { confirmed: true } }),
    ).rejects.toThrow(/recent backup/);
    await expect(
      runtime.reset({
        projectId: 'project-a',
        confirmation: { confirmed: true, backupCreatedAt: '2026-07-21T11:59:59.999Z' },
      }),
    ).rejects.toThrow(/last 24 hours/);
    expect(command).not.toHaveBeenCalled();

    await runtime.reset({
      projectId: 'project-a',
      confirmation: { confirmed: true, backupCreatedAt: '2026-07-22T11:00:00.000Z' },
    });
    expect(command).toHaveBeenCalledWith('db', 'reset', '--workdir', environment.workdir, '--yes');
  });

  it('gates destructive cleanup, removes only its project, and keeps another project intact', async () => {
    const { command, runtime } = fixture();
    const first = await runtime.initialize({ projectId: 'project-a' });
    const second = await runtime.initialize({ projectId: 'project-b' });
    command.mockClear();

    await expect(
      runtime.cleanup({ projectId: 'project-a', confirmation: { confirmed: false } }),
    ).rejects.toThrow(/confirmation/);
    expect(command).not.toHaveBeenCalled();

    await runtime.cleanup({
      projectId: 'project-a',
      confirmation: { confirmed: true, backupCreatedAt: '2026-07-22T11:00:00.000Z' },
    });
    expect(command).toHaveBeenCalledWith(
      'stop',
      '--workdir',
      first.workdir,
      '--no-backup',
      '--yes',
    );
    await expect(stat(first.workdir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(second.workdir)).resolves.toBeDefined();
  });

  it('never trusts persisted metadata to redirect cleanup outside the project environment', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const protectedDir = join(dataDir, 'protected');
    await writeFile(
      join(environment.workdir, 'environment.json'),
      JSON.stringify({
        ...environment,
        workdir: protectedDir,
      }),
    );
    await writeFile(protectedDir, 'keep');
    command.mockClear();

    await runtime.cleanup({
      projectId: 'project-a',
      confirmation: { confirmed: true, backupCreatedAt: '2026-07-22T11:00:00.000Z' },
    });

    await expect(readFile(protectedDir, 'utf8')).resolves.toBe('keep');
    expect(command).toHaveBeenCalledWith(
      'stop',
      '--workdir',
      environment.workdir,
      '--no-backup',
      '--yes',
    );
  });

  it('preserves stopped state and returns bounded redacted diagnostics after a failed start', async () => {
    const { command, runtime } = fixture();
    await runtime.initialize({ projectId: 'project-a' });
    const stopped = await runtime.stop('project-a');
    command.mockRejectedValueOnce(
      Object.assign(new Error(`JWT_SECRET=secret-value ${'x'.repeat(10_000)}`), {
        exitCode: 1,
        stdout: 'ANON_KEY=another-secret',
        stderr: '{"JWT_SECRET":"json-secret","PASSWORD":"hunter2"}',
      }),
    );

    const rejection = await runtime.start('project-a').catch((error: unknown) => error);

    expect(rejection).toMatchObject({ operation: 'start', exitCode: 1 });
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).not.toMatch(/secret-value|another-secret|json-secret|hunter2/);
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    await expect(runtime.inspect('project-a')).resolves.toEqual(stopped);
  });
});
