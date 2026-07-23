import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentOperationError } from '@agent-foundry/domain';
import { SupabaseGeneratedProjectRuntime, type SupabaseCommand } from './supabase-runtime.js';
import { FunctionArtifactSchema, type FunctionArtifact } from '@agent-foundry/contracts';

const NOW = new Date('2026-07-22T12:00:00.000Z');
const INITIAL_CONFIG = `project_id = "environment"

[api]
enabled = true
port = 54321

[db]
port = 54322
shadow_port = 54320

[db.pooler]
enabled = false
port = 54329

[studio]
enabled = true
port = 54323

[inbucket]
enabled = true
port = 54324
# smtp_port = 54325
# pop3_port = 54326

[edge_runtime]
enabled = true
inspector_port = 8083

[analytics]
enabled = true
port = 54327
`;

const HOST_PORT_FIELDS = [
  ['api', 'port'],
  ['db', 'port'],
  ['db', 'shadow_port'],
  ['studio', 'port'],
  ['inbucket', 'port'],
  ['edge_runtime', 'inspector_port'],
  ['analytics', 'port'],
] as const;

let dataDir: string;
let projectIdsAtStart: string[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-platform-'));
  projectIdsAtStart = [];
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function statusCommand(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const workdirIndex = args.indexOf('--workdir');
  const workdir = workdirIndex === -1 ? undefined : args[workdirIndex + 1];
  if (args[0] === 'init' && workdir) {
    await mkdir(join(workdir, 'supabase'), { recursive: true });
    await writeFile(join(workdir, 'supabase', 'config.toml'), INITIAL_CONFIG);
  }
  if ((args[0] === 'start' || args[0] === 'status') && workdir) {
    const config = await readFile(join(workdir, 'supabase', 'config.toml'), 'utf8');
    if (args[0] === 'start') {
      projectIdsAtStart.push(config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1] ?? 'missing');
    }
    const api = configPort(config, 'api', 'port');
    const db = configPort(config, 'db', 'port');
    const studio = configPort(config, 'studio', 'port');
    const inbucket = configPort(config, 'inbucket', 'port');
    return {
      stdout: JSON.stringify({
        API_URL: `http://127.0.0.1:${api}`,
        GRAPHQL_URL: `http://127.0.0.1:${api}/graphql/v1`,
        STUDIO_URL: `http://127.0.0.1:${studio}`,
        INBUCKET_URL: `http://127.0.0.1:${inbucket}`,
        DB_URL: `postgresql://postgres:db-secret@127.0.0.1:${db}/postgres`,
        JWT_SECRET: 'jwt-secret',
        ANON_KEY: 'anon-secret',
      }),
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

function configPort(config: string, section: string, key: string): number {
  let currentSection = '';
  for (const line of config.split('\n')) {
    currentSection = line.match(/^\[([^\]]+)\]$/)?.[1] ?? currentSection;
    const value =
      currentSection === section
        ? line.match(new RegExp(`^${key}\\s*=\\s*(\\d+)$`))?.[1]
        : undefined;
    if (value) return Number(value);
  }
  throw new Error(`Missing ${section}.${key}`);
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

function dumpingCommand() {
  return vi.fn<SupabaseCommand>(async (...args) => {
    if (args[0] === 'db' && args[1] === 'dump') {
      const backupPath = args[args.indexOf('--file') + 1];
      if (!backupPath) throw new Error('Missing dump file path.');
      await writeFile(backupPath, args.includes('--data-only') ? 'data backup;' : 'schema backup;');
    }
    return statusCommand(...args);
  });
}

function checksum(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeMigration(workdir: string, name: string, sql: string): Promise<string> {
  const migrationPath = `supabase/migrations/${name}`;
  await mkdir(join(workdir, 'supabase', 'migrations'), { recursive: true });
  await writeFile(join(workdir, migrationPath), sql);
  return migrationPath;
}

const FUNCTION_ARTIFACT: FunctionArtifact = FunctionArtifactSchema.parse({
  name: 'hello',
  entrypoint: 'index.ts',
  verifyJwt: true,
  envRefs: ['GREETING_SUFFIX'],
  timeoutMs: 5_000,
  memoryMb: 128,
  egressAllowlist: [],
});

async function deployHello(
  runtime: SupabaseGeneratedProjectRuntime,
  projectId: string,
  workdir: string,
  body = 'export default () => new Response("hi");\n',
) {
  const functionDir = join(workdir, 'supabase', 'functions', 'hello');
  await mkdir(functionDir, { recursive: true });
  await writeFile(join(functionDir, 'index.ts'), body);
  return runtime.deployFunction({
    projectId,
    functionPath: 'supabase/functions/hello',
    artifact: FUNCTION_ARTIFACT,
  });
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
    const firstProjectId = (
      await readFile(join(first.workdir, 'supabase', 'config.toml'), 'utf8')
    ).match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
    const secondProjectId = (
      await readFile(join(second.workdir, 'supabase', 'config.toml'), 'utf8')
    ).match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
    const firstConfig = await readFile(join(first.workdir, 'supabase', 'config.toml'), 'utf8');
    const secondConfig = await readFile(join(second.workdir, 'supabase', 'config.toml'), 'utf8');
    const firstHostPorts = HOST_PORT_FIELDS.map(([section, key]) =>
      configPort(firstConfig, section, key),
    );
    const secondHostPorts = HOST_PORT_FIELDS.map(([section, key]) =>
      configPort(secondConfig, section, key),
    );
    expect(firstProjectId).toBe(first.composeProjectName);
    expect(secondProjectId).toBe(second.composeProjectName);
    expect(firstProjectId).not.toBe(secondProjectId);
    expect(projectIdsAtStart).toEqual(expect.arrayContaining([firstProjectId, secondProjectId]));
    expect(new Set([...firstHostPorts, ...secondHostPorts]).size).toBe(14);
    expect(firstHostPorts.every((port) => port > 0 && port <= 65_535)).toBe(true);
    expect(secondHostPorts.every((port) => port > 0 && port <= 65_535)).toBe(true);
    expect(first.ports.api).toBe(firstHostPorts[0]);
    expect(second.ports.api).toBe(secondHostPorts[0]);
    expect(first.ports.api).not.toBe(second.ports.api);
    expect(first.ports.studio).not.toBe(second.ports.studio);
    expect(first.ports.mail).not.toBe(second.ports.mail);
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
        api: `http://127.0.0.1:${firstHostPorts[0]}`,
        graphql: `http://127.0.0.1:${firstHostPorts[0]}/graphql/v1`,
        studio: `http://127.0.0.1:${firstHostPorts[3]}`,
        mail: `http://127.0.0.1:${firstHostPorts[4]}`,
      },
      ports: {
        api: firstHostPorts[0],
        graphql: firstHostPorts[0],
        studio: firstHostPorts[3],
        mail: firstHostPorts[4],
      },
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
    expect(command.mock.calls).not.toContainEqual(expect.arrayContaining(['migration', 'down']));
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

  it('previews and applies contained create and alter migration artifacts', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const createPath = await writeMigration(
      environment.workdir,
      '20260723120000_create_tasks.sql',
      'CREATE TABLE tasks (id bigint PRIMARY KEY);',
    );
    const alterPath = await writeMigration(
      environment.workdir,
      '20260723120100_add_task_title.sql',
      'ALTER TABLE tasks ADD COLUMN title text;',
    );
    command.mockClear();

    await expect(
      runtime.previewMigration({ projectId: 'project-a', migrationPath: createPath }),
    ).resolves.toMatchObject({ migrationPath: createPath, destructiveStatements: [] });
    await expect(
      runtime.previewMigration({ projectId: 'project-a', migrationPath: alterPath }),
    ).resolves.toMatchObject({ migrationPath: alterPath, destructiveStatements: [] });
    await runtime.migrate({ projectId: 'project-a', migrationPath: createPath });
    await runtime.migrate({ projectId: 'project-a', migrationPath: alterPath });

    expect(command.mock.calls).toEqual([
      ['migration', 'up', '--workdir', environment.workdir, '--yes'],
      ['migration', 'up', '--workdir', environment.workdir, '--yes'],
    ]);
    await expect(
      runtime.previewMigration({
        projectId: 'project-a',
        migrationPath: 'supabase/config.toml',
      }),
    ).rejects.toThrow(/supabase\/migrations/);
  });

  it('finds required destructive statements after removing SQL comments', async () => {
    const { runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const migrationPath = await writeMigration(
      environment.workdir,
      '20260723120200_destructive.sql',
      `-- DROP TABLE ignored_line_comment;
/* TRUNCATE TABLE ignored_block_comment; */
DROP TABLE obsolete;
TRUNCATE TABLE events;
DELETE FROM sessions WHERE expired;
ALTER TABLE tasks DROP COLUMN legacy;
SELECT '-- not a comment'; DROP TABLE quoted_line_marker;`,
    );

    const preview = await runtime.previewMigration({
      projectId: 'project-a',
      migrationPath,
    });

    expect(preview.destructiveStatements).toEqual([
      'DROP TABLE obsolete',
      'TRUNCATE TABLE events',
      'DELETE FROM sessions WHERE expired',
      'ALTER TABLE tasks DROP COLUMN legacy',
      'DROP TABLE quoted_line_marker',
    ]);
  });

  it('requires matching approval and a current untampered backup for destructive migration', async () => {
    const command = dumpingCommand();
    const { runtime } = fixture(command);
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const sql = 'DROP TABLE tasks;';
    const migrationPath = await writeMigration(
      environment.workdir,
      '20260723120300_drop_tasks.sql',
      sql,
    );
    await mkdir(join(environment.workdir, 'supabase', 'backups'), { recursive: true });
    command.mockClear();

    const preview = await runtime.previewMigration({ projectId: 'project-a', migrationPath });
    await expect(runtime.migrate({ projectId: 'project-a', migrationPath })).rejects.toThrow(
      /approval and verified backup/,
    );

    const backup = await runtime.backupMigration({
      projectId: 'project-a',
      backupPath: 'supabase/backups/20260723.sql',
    });
    const dumpCalls = command.mock.calls.filter(([name, subcommand]) => {
      return name === 'db' && subcommand === 'dump';
    });
    expect(dumpCalls).toHaveLength(2);
    expect(dumpCalls[0]).toEqual([
      'db',
      'dump',
      '--workdir',
      environment.workdir,
      '--local',
      '--file',
      expect.stringMatching(/\.schema\.sql$/),
    ]);
    expect(dumpCalls[1]).toEqual([
      'db',
      'dump',
      '--workdir',
      environment.workdir,
      '--local',
      '--data-only',
      '--file',
      expect.stringMatching(/\.data\.sql$/),
    ]);
    expect(backup).toMatchObject({
      path: 'supabase/backups/20260723.sql',
      createdAt: NOW.toISOString(),
      schemaChecksum: checksum('schema backup;'),
      dataChecksum: checksum('data backup;'),
      manifestId: expect.any(String),
    });
    await expect(readFile(join(environment.workdir, backup.path), 'utf8')).resolves.toBe(
      'schema backup;\ndata backup;',
    );
    const manifestPath = join(
      dataDir,
      'migration-backups',
      'project-a',
      `${backup.manifestId}.json`,
    );
    await expect(readFile(manifestPath, 'utf8').then(JSON.parse)).resolves.toEqual(backup);

    const approval = { migrationChecksum: preview.checksum, backup };
    await writeFile(join(environment.workdir, migrationPath), 'DROP TABLE changed_tasks;');
    await expect(
      runtime.migrate({ projectId: 'project-a', migrationPath, approval }),
    ).rejects.toThrow(/migration.*changed/i);

    await writeFile(join(environment.workdir, migrationPath), sql);
    await writeFile(join(environment.workdir, backup.path), 'tampered backup');
    await expect(
      runtime.migrate({ projectId: 'project-a', migrationPath, approval }),
    ).rejects.toThrow(/backup.*changed/i);

    await writeFile(join(environment.workdir, backup.path), 'schema backup;\ndata backup;');
    const staleBackup = { ...backup, createdAt: '2026-07-21T11:59:59.999Z' };
    await expect(
      runtime.migrate({
        projectId: 'project-a',
        migrationPath,
        approval: { ...approval, backup: staleBackup },
      }),
    ).rejects.toThrow(/provenance/);

    await writeFile(manifestPath, JSON.stringify(staleBackup));
    await expect(
      runtime.migrate({
        projectId: 'project-a',
        migrationPath,
        approval: { ...approval, backup: staleBackup },
      }),
    ).rejects.toThrow(/last 24 hours/);
    await writeFile(manifestPath, JSON.stringify(backup));

    await runtime.migrate({ projectId: 'project-a', migrationPath, approval });
    expect(command.mock.calls.at(-1)).toEqual([
      'migration',
      'up',
      '--workdir',
      environment.workdir,
      '--yes',
    ]);
    expect(command.mock.calls).not.toContainEqual(expect.arrayContaining(['migration', 'down']));
  });

  it('gates every destructive sibling that migration up could apply', async () => {
    const command = dumpingCommand();
    const { runtime } = fixture(command);
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const safePath = await writeMigration(
      environment.workdir,
      '20260723120300_add_task_title.sql',
      'ALTER TABLE tasks ADD COLUMN title text;',
    );
    const firstDestructivePath = await writeMigration(
      environment.workdir,
      '20260723120400_drop_tasks.sql',
      'DROP TABLE tasks;',
    );
    const secondDestructivePath = await writeMigration(
      environment.workdir,
      '20260723120500_truncate_events.sql',
      'TRUNCATE TABLE events;',
    );
    await mkdir(join(environment.workdir, 'supabase', 'backups'), { recursive: true });
    const backup = await runtime.backupMigration({
      projectId: 'project-a',
      backupPath: 'supabase/backups/batch.sql',
    });
    const [firstDestructive, secondDestructive] = await Promise.all([
      runtime.previewMigration({
        projectId: 'project-a',
        migrationPath: firstDestructivePath,
      }),
      runtime.previewMigration({
        projectId: 'project-a',
        migrationPath: secondDestructivePath,
      }),
    ]);
    command.mockClear();

    await expect(
      runtime.migrate({
        projectId: 'project-a',
        migrationPath: safePath,
        approval: { migrationChecksum: firstDestructive.checksum, backup },
      }),
    ).rejects.toThrow(/every destructive migration/i);
    expect(command).not.toHaveBeenCalled();

    await runtime.migrate({
      projectId: 'project-a',
      migrationPath: safePath,
      approval: {
        migrationChecksum: firstDestructive.checksum,
        migrationChecksums: [firstDestructive.checksum, secondDestructive.checksum],
        backup,
      },
    });
    expect(command.mock.calls).toEqual([
      ['migration', 'up', '--workdir', environment.workdir, '--yes'],
    ]);
  });

  it('rejects caller-forged backup provenance for an arbitrary contained artifact', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    const migrationPath = await writeMigration(
      environment.workdir,
      '20260723120600_drop_tasks.sql',
      'DROP TABLE tasks;',
    );
    await mkdir(join(environment.workdir, 'supabase', 'backups'), { recursive: true });
    const backupPath = 'supabase/backups/forged.sql';
    const backupContents = 'caller supplied backup';
    await writeFile(join(environment.workdir, backupPath), backupContents);
    const preview = await runtime.previewMigration({ projectId: 'project-a', migrationPath });
    command.mockClear();

    await expect(
      runtime.migrate({
        projectId: 'project-a',
        migrationPath,
        approval: {
          migrationChecksum: preview.checksum,
          backup: {
            path: backupPath,
            checksum: checksum(backupContents),
            schemaChecksum: 'a'.repeat(64),
            dataChecksum: 'b'.repeat(64),
            createdAt: NOW.toISOString(),
            manifestId: 'forged',
          },
        },
      }),
    ).rejects.toThrow(/generated backup manifest|provenance/i);
    expect(command).not.toHaveBeenCalled();
  });

  it('runs seed only for a path contained by the project workdir', async () => {
    const { command, runtime } = fixture();
    const environment = await runtime.initialize({ projectId: 'project-a' });
    await writeFile(join(environment.workdir, 'seed.sql'), 'select 1;');
    command.mockClear();

    await runtime.seed({ projectId: 'project-a', seedPath: 'seed.sql' });

    expect(command.mock.calls).toEqual([['seed', '--workdir', environment.workdir, '--yes']]);
    await expect(
      runtime.seed({ projectId: 'project-a', seedPath: join(dataDir, 'outside.sql') }),
    ).rejects.toThrow(/relative path/);
    expect(command).toHaveBeenCalledTimes(1);
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
        stdout:
          'ANON_KEY=another-secret DB_URL=postgresql://postgres:db-password@127.0.0.1:54322/postgres DATABASE_URL="postgresql://postgres:database-password@localhost/db"',
        stderr: '{"JWT_SECRET":"json-secret","PASSWORD":"hunter2"}',
      }),
    );

    const rejection = await runtime.start('project-a').catch((error: unknown) => error);

    expect(rejection).toMatchObject({ operation: 'start', exitCode: 1 });
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).not.toMatch(
      /secret-value|another-secret|db-password|database-password|json-secret|hunter2/,
    );
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    await expect(runtime.inspect('project-a')).resolves.toEqual(stopped);
  });

  it('caps multibyte diagnostics at 8 KiB without splitting a UTF-8 character', async () => {
    const { command, runtime } = fixture();
    await runtime.initialize({ projectId: 'project-a' });
    await runtime.stop('project-a');
    command.mockRejectedValueOnce(
      Object.assign(new Error(`a${'😀'.repeat(3_000)}`), { exitCode: 1 }),
    );

    const rejection = await runtime.start('project-a').catch((error: unknown) => error);

    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(rejection.diagnostic).not.toContain('�');
  });
});

describe('function deployment', () => {
  it('deploys a function as an immutable, checksummed version and activates it', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project' });
    const version = await deployHello(runtime, 'fn-project', environment.workdir);

    expect(version.functionName).toBe('hello');
    expect(version.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(version.artifact).toEqual(FUNCTION_ARTIFACT);

    const live = await readFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'utf8',
    );
    expect(live).toContain('new Response("hi")');

    const config = await readFile(join(environment.workdir, 'supabase', 'config.toml'), 'utf8');
    expect(config).toContain('[functions.hello]');
    expect(config).toContain('verify_jwt = true');
  });

  it('rejects a function source path outside the declared function name', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-2' });
    const functionDir = join(environment.workdir, 'supabase', 'functions', 'other');
    await mkdir(functionDir, { recursive: true });
    await writeFile(join(functionDir, 'index.ts'), 'export default () => new Response("hi");\n');

    await expect(
      runtime.deployFunction({
        projectId: 'fn-project-2',
        functionPath: 'supabase/functions/other',
        artifact: FUNCTION_ARTIFACT,
      }),
    ).rejects.toThrow(/must match/);
  });

  it('rejects a source path that escapes the project workdir', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    await runtime.initialize({ projectId: 'fn-project-3' });

    await expect(
      runtime.deployFunction({
        projectId: 'fn-project-3',
        functionPath: '../../etc/hello',
        artifact: FUNCTION_ARTIFACT,
      }),
    ).rejects.toThrow();
  });

  it('lists deployed versions oldest first and supports rollback to a prior version', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-4' });
    const first = await deployHello(
      runtime,
      'fn-project-4',
      environment.workdir,
      'export default () => new Response("v1");\n',
    );
    const second = await deployHello(
      runtime,
      'fn-project-4',
      environment.workdir,
      'export default () => new Response("v2");\n',
    );

    const versions = await runtime.listFunctionVersions({
      projectId: 'fn-project-4',
      functionName: 'hello',
    });
    expect(versions.map((version) => version.versionId)).toEqual([
      first.versionId,
      second.versionId,
    ]);

    await runtime.rollbackFunction({
      projectId: 'fn-project-4',
      functionName: 'hello',
      versionId: first.versionId,
    });
    const live = await readFile(
      join(environment.workdir, 'supabase', 'functions', 'hello', 'index.ts'),
      'utf8',
    );
    expect(live).toContain('new Response("v1")');
  });

  it('rejects rollback to an unknown version id', async () => {
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: statusCommand,
      now: () => NOW,
    });
    const environment = await runtime.initialize({ projectId: 'fn-project-5' });
    await deployHello(runtime, 'fn-project-5', environment.workdir);

    await expect(
      runtime.rollbackFunction({
        projectId: 'fn-project-5',
        functionName: 'hello',
        versionId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/was not found/);
  });
});
