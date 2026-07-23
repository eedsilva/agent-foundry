import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentOperationError } from '@agent-foundry/domain';
import { SupabaseGeneratedProjectRuntime, type SupabaseCommand } from './supabase-runtime.js';
import { GENERATED_STORAGE_MIGRATION, generatedStorageMigration } from './supabase-storage.js';

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
let migrationsAtStart: string[];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-platform-'));
  projectIdsAtStart = [];
  migrationsAtStart = [];
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
    await mkdir(join(workdir, 'supabase', 'migrations'), { recursive: true });
    await writeFile(join(workdir, 'supabase', 'config.toml'), INITIAL_CONFIG);
  }
  if ((args[0] === 'start' || args[0] === 'status') && workdir) {
    const config = await readFile(join(workdir, 'supabase', 'config.toml'), 'utf8');
    if (args[0] === 'start') {
      const migration = await readFile(
        join(workdir, 'supabase', 'migrations', GENERATED_STORAGE_MIGRATION),
        'utf8',
      );
      migrationsAtStart.push(migration);
      expect(migration).toBe(generatedStorageMigration());
      projectIdsAtStart.push(config.match(/^project_id\s*=\s*"([^"]+)"/m)?.[1] ?? 'missing');
    }
    const api = configPort(config, 'api', 'port');
    const db = configPort(config, 'db', 'port');
    const studio = configPort(config, 'studio', 'port');
    const inbucket = configPort(config, 'inbucket', 'port');
    if (args[0] === 'start') {
      return {
        stdout: `Started supabase local development setup.
API URL: http://127.0.0.1:${api}
GraphQL URL: http://127.0.0.1:${api}/graphql/v1
Studio URL: http://127.0.0.1:${studio}`,
        stderr: '',
        exitCode: 0,
      };
    }
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
    const firstMigration = await readFile(
      join(first.workdir, 'supabase', 'migrations', GENERATED_STORAGE_MIGRATION),
      'utf8',
    );
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
    expect(firstConfig).toContain(`[storage.buckets.uploads]
public = false
file_size_limit = "10MiB"
allowed_mime_types = ["image/png", "image/jpeg", "application/pdf"]`);
    expect(firstMigration).toBe(generatedStorageMigration());
    expect(firstMigration).toContain('create policy storage_upload_insert');
    expect(firstMigration).toContain('create policy storage_clean_owner_select');
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
    expect(command.mock.calls).toContainEqual(['seed', 'buckets', '--workdir', first.workdir]);
    expect(command.mock.calls).toContainEqual([
      'status',
      '--workdir',
      first.workdir,
      '--output',
      'json',
    ]);
    const firstStart = command.mock.calls.findIndex(
      ([name, , value]) => name === 'start' && value === first.workdir,
    );
    const firstSeed = command.mock.calls.findIndex(
      ([name, , , value]) => name === 'seed' && value === first.workdir,
    );
    const firstStatus = command.mock.calls.findIndex(
      ([name, , value]) => name === 'status' && value === first.workdir,
    );
    expect(firstStart).toBeLessThan(firstSeed);
    expect(firstSeed).toBeLessThan(firstStatus);
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

  it('tears down the exact workdir after a partial start failure', async () => {
    const workdir = join(dataDir, 'projects', 'project-a', 'environment');
    const partialMarker = join(workdir, 'partial-start');
    const command = vi.fn<SupabaseCommand>(async (...args) => {
      if (args[0] === 'start') {
        await writeFile(partialMarker, 'partial');
        throw Object.assign(
          new Error(`PASSWORD=start-secret partial-start-failure ${'x'.repeat(10_000)}`),
          {
            exitCode: 44,
            stderr: 'ACCESS_TOKEN=start-token',
          },
        );
      }
      return statusCommand(...args);
    });
    const { runtime } = fixture(command);

    const rejection = await runtime.initialize({ projectId: 'project-a' }).catch((error) => error);

    expect(rejection).toMatchObject({ operation: 'start', exitCode: 44 });
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).toContain('partial-start-failure');
    expect(rejection.diagnostic).not.toMatch(/start-secret|start-token/);
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(command.mock.calls.slice(-2)).toEqual([
      [
        'start',
        '--workdir',
        workdir,
        '--output',
        'json',
        '--yes',
        '--network-id',
        'supabase_project-a_network',
      ],
      ['stop', '--workdir', workdir, '--no-backup', '--yes'],
    ]);
    await expect(stat(workdir)).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('retains a failed seed workdir and recovers it across runtime instances', async () => {
    let failSeed = true;
    let stopAttempts = 0;
    let freshAtRetryInit = false;
    const workdir = join(dataDir, 'projects', 'project-a', 'environment');
    const partialMarker = join(workdir, 'partial-marker');
    const command = vi.fn<SupabaseCommand>(async (...args) => {
      if (args[0] === 'seed' && args[1] === 'buckets' && failSeed) {
        failSeed = false;
        await writeFile(partialMarker, 'partial');
        throw Object.assign(
          new Error(`PASSWORD=seed-secret original-seed-failure ${'x'.repeat(10_000)}`),
          {
            exitCode: 41,
          },
        );
      }
      if (args[0] === 'stop') {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          throw new Error(`PASSWORD=cleanup-secret cleanup-stop-failure ${'y'.repeat(10_000)}`);
        }
      }
      if (args[0] === 'init' && stopAttempts === 2) {
        await expect(stat(partialMarker)).rejects.toMatchObject({ code: 'ENOENT' });
        freshAtRetryInit = true;
      }
      return statusCommand(...args);
    });
    const { runtime } = fixture(command);
    const protectedPath = join(dataDir, 'projects', 'project-b', 'environment', 'keep');
    await mkdir(join(dataDir, 'projects', 'project-b', 'environment'), { recursive: true });
    await writeFile(protectedPath, 'keep');

    const firstInitialization = runtime.initialize({ projectId: 'project-a' });
    const secondInitialization = runtime.initialize({ projectId: 'project-a' });
    const [rejection, sameRejection] = await Promise.all([
      firstInitialization.catch((error) => error),
      secondInitialization.catch((error) => error),
    ]);

    expect(rejection).toMatchObject({ operation: 'initialize', exitCode: 41 });
    expect(sameRejection).toBe(rejection);
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).toContain('original-seed-failure');
    expect(rejection.diagnostic).toContain('cleanup-stop-failure');
    expect(rejection.diagnostic).not.toMatch(/seed-secret|cleanup-secret/);
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(command.mock.calls).toContainEqual([
      'stop',
      '--workdir',
      workdir,
      '--no-backup',
      '--yes',
    ]);
    await expect(readFile(join(workdir, 'supabase', 'config.toml'), 'utf8')).resolves.toContain(
      'project_id = "supabase_project-a"',
    );
    await expect(readFile(partialMarker, 'utf8')).resolves.toBe('partial');
    await expect(readFile(protectedPath, 'utf8')).resolves.toBe('keep');
    await expect(runtime.inspect('project-a')).resolves.toBeNull();

    const retryCallIndex = command.mock.calls.length;
    const retryRuntime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command,
      now: () => new Date(NOW),
    });
    const retried = await retryRuntime.initialize({ projectId: 'project-a' });

    expect(retried.workdir).toBe(workdir);
    expect(freshAtRetryInit).toBe(true);
    expect(stopAttempts).toBe(2);
    expect(command.mock.calls.slice(retryCallIndex, retryCallIndex + 2)).toEqual([
      ['stop', '--workdir', workdir, '--no-backup', '--yes'],
      ['init', '--workdir', workdir],
    ]);
    expect(command.mock.calls.filter(([name]) => name === 'init')).toHaveLength(2);
    expect(command.mock.calls.filter(([name]) => name === 'start')).toHaveLength(2);
    expect(
      command.mock.calls.filter(([name, subcommand]) => {
        return name === 'seed' && subcommand === 'buckets';
      }),
    ).toHaveLength(2);
  });

  it('removes a failed pre-start workdir so the same runtime can retry initialization', async () => {
    const workdir = join(dataDir, 'projects', 'project-a', 'environment');
    const partialMarker = join(workdir, 'partial-init');
    let failInit = true;
    const command = vi.fn<SupabaseCommand>(async (...args) => {
      if (args[0] === 'init' && failInit) {
        failInit = false;
        await writeFile(partialMarker, 'partial');
        throw Object.assign(new Error('PASSWORD=init-secret partial-init-failure'), {
          exitCode: 45,
        });
      }
      if (args[0] === 'init') {
        await expect(stat(partialMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      }
      return statusCommand(...args);
    });
    const { runtime } = fixture(command);

    const rejection = await runtime.initialize({ projectId: 'project-a' }).catch((error) => error);

    expect(rejection).toMatchObject({ operation: 'initialize', exitCode: 45 });
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).toContain('partial-init-failure');
    expect(rejection.diagnostic).not.toContain('init-secret');
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(command.mock.calls).toEqual([['init', '--workdir', workdir]]);
    await expect(stat(workdir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runtime.inspect('project-a')).resolves.toBeNull();

    await expect(runtime.initialize({ projectId: 'project-a' })).resolves.toMatchObject({
      projectId: 'project-a',
      workdir,
      health: { state: 'healthy' },
    });
    expect(command.mock.calls.filter(([name]) => name === 'stop')).toHaveLength(0);
    expect(command.mock.calls.filter(([name]) => name === 'init')).toHaveLength(2);
    expect(command.mock.calls.filter(([name]) => name === 'start')).toHaveLength(1);
  });

  it('rolls back and redacts an authoritative status failure after bucket seed', async () => {
    const workdir = join(dataDir, 'projects', 'project-a', 'environment');
    const command = vi.fn<SupabaseCommand>(async (...args) => {
      if (args[0] === 'status') {
        throw Object.assign(
          new Error(`PASSWORD=status-secret authoritative-status-failure ${'x'.repeat(10_000)}`),
          {
            exitCode: 43,
            stderr: 'JWT_SECRET=status-json-secret',
          },
        );
      }
      return statusCommand(...args);
    });
    const { runtime } = fixture(command);

    const rejection = await runtime.initialize({ projectId: 'project-a' }).catch((error) => error);

    expect(rejection).toMatchObject({ operation: 'initialize', exitCode: 43 });
    if (!(rejection instanceof EnvironmentOperationError)) throw rejection;
    expect(rejection.diagnostic).toContain('authoritative-status-failure');
    expect(rejection.diagnostic).not.toMatch(/status-secret|status-json-secret/);
    expect(Buffer.byteLength(rejection.diagnostic)).toBeLessThanOrEqual(8 * 1024);
    expect(command.mock.calls.slice(-4)).toEqual([
      [
        'start',
        '--workdir',
        workdir,
        '--output',
        'json',
        '--yes',
        '--network-id',
        'supabase_project-a_network',
      ],
      ['seed', 'buckets', '--workdir', workdir],
      ['status', '--workdir', workdir, '--output', 'json'],
      ['stop', '--workdir', workdir, '--no-backup', '--yes'],
    ]);
    await expect(stat(workdir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(runtime.inspect('project-a')).resolves.toBeNull();
  });

  it('deduplicates overlapping project initialization without blocking another project', async () => {
    const projectAWorkdir = join(dataDir, 'projects', 'project-a', 'environment');
    let releaseProjectA = () => {};
    const projectAGate = new Promise<void>((resolve) => {
      releaseProjectA = resolve;
    });
    let markProjectAStarted = () => {};
    const projectAStarted = new Promise<void>((resolve) => {
      markProjectAStarted = resolve;
    });
    const command = vi.fn<SupabaseCommand>(async (...args) => {
      const workdir = args[args.indexOf('--workdir') + 1];
      if (args[0] === 'init' && workdir === projectAWorkdir) {
        markProjectAStarted();
        await projectAGate;
      }
      return statusCommand(...args);
    });
    const { runtime } = fixture(command);

    const firstProjectA = runtime.initialize({ projectId: 'project-a' });
    await projectAStarted;
    const secondProjectA = runtime.initialize({ projectId: 'project-a' });
    const projectB = await runtime.initialize({ projectId: 'project-b' });
    releaseProjectA();
    const [first, second] = await Promise.all([firstProjectA, secondProjectA]);

    expect(first).toEqual(second);
    expect(projectB.projectId).toBe('project-b');
    expect(
      command.mock.calls.filter(
        ([name, , workdir]) => name === 'init' && workdir === projectAWorkdir,
      ),
    ).toHaveLength(1);
    expect(
      command.mock.calls.filter(
        ([name, , workdir]) => name === 'start' && workdir === projectAWorkdir,
      ),
    ).toHaveLength(1);
    expect(
      command.mock.calls.filter(
        ([name, subcommand, , workdir]) =>
          name === 'seed' && subcommand === 'buckets' && workdir === projectAWorkdir,
      ),
    ).toHaveLength(1);
  });

  it('makes stop and restart idempotent while preserving exact lifecycle commands', async () => {
    const { command, runtime } = fixture();
    const initialized = await runtime.initialize({ projectId: 'project-a' });

    const stopped = await runtime.stop('project-a');
    await runtime.stop('project-a');
    const restartCallIndex = command.mock.calls.length;
    const restarted = await runtime.start('project-a');
    await runtime.start('project-a');

    expect(stopped.health.state).toBe('stopped');
    expect(restarted.health.state).toBe('healthy');
    expect(command.mock.calls.filter(([name]) => name === 'stop')).toEqual([
      ['stop', '--workdir', initialized.workdir],
    ]);
    expect(command.mock.calls.filter(([name]) => name === 'start')).toHaveLength(2);
    expect(command.mock.calls.slice(restartCallIndex)).toEqual([
      [
        'start',
        '--workdir',
        initialized.workdir,
        '--output',
        'json',
        '--yes',
        '--network-id',
        initialized.network,
      ],
      ['status', '--workdir', initialized.workdir, '--output', 'json'],
    ]);
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
