import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import {
  AppEnvironmentSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
} from '@agent-foundry/contracts';
import {
  EnvironmentOperationError,
  ValidationError,
  redactString,
  type GeneratedProjectRuntime,
} from '@agent-foundry/domain';

const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;

export interface SupabaseCommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}

export type SupabaseCommand = (...args: string[]) => Promise<SupabaseCommandResult>;

export interface SupabaseGeneratedProjectRuntimeOptions {
  dataDir: string;
  command?: SupabaseCommand;
  now?: () => Date;
}

const defaultCommand: SupabaseCommand = async (...args) => {
  const result = await execa('supabase', args);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
  };
};

export class SupabaseGeneratedProjectRuntime implements GeneratedProjectRuntime {
  readonly #dataDir: string;
  readonly #command: SupabaseCommand;
  readonly #now: () => Date;

  constructor(options: SupabaseGeneratedProjectRuntimeOptions) {
    this.#dataDir = options.dataDir;
    this.#command = options.command ?? defaultCommand;
    this.#now = options.now ?? (() => new Date());
  }

  async initialize(input: { projectId: string }): Promise<AppEnvironment> {
    const existing = await this.#read(input.projectId);
    if (existing) return existing;

    const projectId = safeProjectId(input.projectId);
    const { workdir, composeProjectName, network, volumes } = projectResources(
      this.#dataDir,
      projectId,
    );
    await mkdir(workdir, { recursive: true });
    await this.#execute('initialize', 'init', '--workdir', workdir);
    const result = await this.#execute(
      'start',
      'start',
      '--workdir',
      workdir,
      '--output',
      'json',
      '--yes',
      '--network-id',
      network,
    );
    const timestamp = this.#now().toISOString();
    const environment = environmentFromStatus(
      {
        projectId,
        composeProjectName,
        workdir,
        network,
        volumes,
        ports: {},
        endpoints: {},
        health: { state: 'healthy', checkedAt: timestamp },
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      result.stdout,
      'healthy',
      timestamp,
      'start',
    );
    await persist(environment);
    return environment;
  }

  async start(projectId: string): Promise<AppEnvironment> {
    const environment = await this.#require(projectId);
    if (environment.health.state === 'healthy') return environment;
    const result = await this.#execute(
      'start',
      'start',
      '--workdir',
      environment.workdir,
      '--output',
      'json',
      '--yes',
      '--network-id',
      environment.network,
    );
    const timestamp = this.#now().toISOString();
    const started = environmentFromStatus(
      environment,
      result.stdout,
      'healthy',
      timestamp,
      'start',
    );
    await persist(started);
    return started;
  }

  async stop(projectId: string): Promise<AppEnvironment> {
    const environment = await this.#require(projectId);
    if (environment.health.state === 'stopped') return environment;
    await this.#execute('stop', 'stop', '--workdir', environment.workdir);
    const timestamp = this.#now().toISOString();
    const stopped = AppEnvironmentSchema.parse({
      ...environment,
      health: { state: 'stopped', checkedAt: timestamp },
      updatedAt: timestamp,
    });
    await persist(stopped);
    return stopped;
  }

  async inspect(projectId: string): Promise<AppEnvironment | null> {
    const environment = await this.#read(projectId);
    if (!environment) return null;
    const result = await this.#execute(
      'inspect',
      'status',
      '--workdir',
      environment.workdir,
      '--output',
      'json',
    );
    const timestamp = this.#now().toISOString();
    const inspected = environmentFromStatus(
      environment,
      result.stdout,
      environment.health.state,
      timestamp,
      'inspect',
    );
    await persist(inspected);
    return inspected;
  }

  async migrate(input: { projectId: string; migrationPath: string }): Promise<AppEnvironment> {
    const environment = await this.#require(input.projectId);
    await requireContainedFile(environment.workdir, input.migrationPath);
    await this.#execute('migrate', 'migration', 'up', '--workdir', environment.workdir, '--yes');
    return this.#touch(environment);
  }

  async seed(input: { projectId: string; seedPath: string }): Promise<AppEnvironment> {
    const environment = await this.#require(input.projectId);
    await requireContainedFile(environment.workdir, input.seedPath);
    await this.#execute('seed', 'seed', '--workdir', environment.workdir, '--yes');
    return this.#touch(environment);
  }

  async health(projectId: string): Promise<AppEnvironment> {
    const environment = await this.#require(projectId);
    const result = await this.#execute(
      'health',
      'status',
      '--workdir',
      environment.workdir,
      '--output',
      'json',
    );
    const timestamp = this.#now().toISOString();
    const healthy = environmentFromStatus(
      environment,
      result.stdout,
      'healthy',
      timestamp,
      'health',
    );
    await persist(healthy);
    return healthy;
  }

  async reset(input: {
    projectId: string;
    confirmation: DestructiveEnvironmentConfirmation;
  }): Promise<AppEnvironment> {
    requireDestructiveConfirmation(input.confirmation, this.#now());
    const environment = await this.#require(input.projectId);
    await this.#execute('reset', 'db', 'reset', '--workdir', environment.workdir, '--yes');
    return this.#touch(environment);
  }

  async cleanup(input: {
    projectId: string;
    confirmation: DestructiveEnvironmentConfirmation;
  }): Promise<void> {
    requireDestructiveConfirmation(input.confirmation, this.#now());
    const environment = await this.#read(input.projectId);
    if (!environment) return;
    await this.#execute(
      'cleanup',
      'stop',
      '--workdir',
      environment.workdir,
      '--no-backup',
      '--yes',
    );
    await rm(environment.workdir, { recursive: true, force: true });
  }

  async #read(projectId: string): Promise<AppEnvironment | null> {
    const safeId = safeProjectId(projectId);
    const path = metadataPath(this.#dataDir, safeId);
    try {
      const environment = AppEnvironmentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      return AppEnvironmentSchema.parse({
        ...environment,
        projectId: safeId,
        ...projectResources(this.#dataDir, safeId),
      });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async #require(projectId: string): Promise<AppEnvironment> {
    const environment = await this.#read(projectId);
    if (!environment)
      throw new ValidationError(`Project environment "${projectId}" is not initialized.`);
    return environment;
  }

  async #touch(environment: AppEnvironment): Promise<AppEnvironment> {
    const updated = AppEnvironmentSchema.parse({
      ...environment,
      updatedAt: this.#now().toISOString(),
    });
    await persist(updated);
    return updated;
  }

  async #execute(
    operation: EnvironmentLifecycleOperation,
    ...args: string[]
  ): Promise<SupabaseCommandResult> {
    try {
      const result = await this.#command(...args);
      if (result.exitCode !== undefined && result.exitCode !== 0) {
        throw Object.assign(new Error('Supabase command failed.'), result);
      }
      return result;
    } catch (error) {
      if (error instanceof EnvironmentOperationError) throw error;
      throw operationError(operation, error);
    }
  }
}

function safeProjectId(projectId: string): string {
  const result = PathSegmentSchema.safeParse(projectId);
  if (!result.success) throw new ValidationError(`Invalid project ID: ${result.error.message}`);
  return result.data;
}

function environmentDir(dataDir: string, projectId: string): string {
  return join(dataDir, 'projects', projectId, 'environment');
}

function projectResources(dataDir: string, projectId: string) {
  const composeProjectName = `supabase_${projectId}`;
  return {
    composeProjectName,
    workdir: environmentDir(dataDir, projectId),
    network: `${composeProjectName}_network`,
    volumes: [`${composeProjectName}_db_data`],
  };
}

function metadataPath(dataDir: string, projectId: string): string {
  return join(environmentDir(dataDir, projectId), 'environment.json');
}

function publicStatus(
  stdout: string,
  operation: EnvironmentLifecycleOperation,
): {
  endpoints: Record<string, string>;
  ports: Record<string, number>;
} {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch (error) {
    throw operationError(operation, error);
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new EnvironmentOperationError(
      operation,
      undefined,
      'Supabase returned invalid status JSON.',
    );
  }
  const source = status as Record<string, unknown>;
  const endpoints: Record<string, string> = {};
  const ports: Record<string, number> = {};
  for (const [field, name] of [
    ['API_URL', 'api'],
    ['GRAPHQL_URL', 'graphql'],
    ['STUDIO_URL', 'studio'],
    ['INBUCKET_URL', 'mail'],
  ] as const) {
    const value = source[field];
    if (typeof value !== 'string' || !URL.canParse(value)) continue;
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) continue;
    endpoints[name] = value;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports[name] = port;
  }
  return { endpoints, ports };
}

function environmentFromStatus(
  environment: AppEnvironment,
  stdout: string,
  state: AppEnvironment['health']['state'],
  timestamp: string,
  operation: EnvironmentLifecycleOperation,
): AppEnvironment {
  const status = publicStatus(stdout, operation);
  return AppEnvironmentSchema.parse({
    ...environment,
    endpoints: Object.keys(status.endpoints).length ? status.endpoints : environment.endpoints,
    ports: Object.keys(status.ports).length ? status.ports : environment.ports,
    health: { state, checkedAt: timestamp },
    updatedAt: timestamp,
  });
}

function requireDestructiveConfirmation(
  confirmation: DestructiveEnvironmentConfirmation,
  now: Date,
): void {
  if (!confirmation.confirmed) {
    throw new ValidationError('Destructive environment operation requires confirmation.');
  }
  if (!confirmation.backupCreatedAt) {
    throw new ValidationError('Destructive environment operation requires a recent backup.');
  }
  const backupTime = new Date(confirmation.backupCreatedAt).getTime();
  const age = now.getTime() - backupTime;
  if (!Number.isFinite(backupTime) || age < 0 || age > MAX_BACKUP_AGE_MS) {
    throw new ValidationError(
      'Destructive environment operation requires a backup from the last 24 hours.',
    );
  }
}

async function requireContainedFile(workdir: string, inputPath: string): Promise<void> {
  if (isAbsolute(inputPath)) {
    throw new ValidationError('Environment file must be a relative path.');
  }
  const candidate = resolve(workdir, inputPath);
  if (!isContained(workdir, candidate)) {
    throw new ValidationError('Environment file must remain inside the project environment.');
  }
  const [resolvedWorkdir, resolvedCandidate] = await Promise.all([
    realpath(workdir),
    realpath(candidate),
  ]);
  if (!isContained(resolvedWorkdir, resolvedCandidate)) {
    throw new ValidationError('Environment file must remain inside the project environment.');
  }
}

function isContained(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(path)
  );
}

async function persist(environment: AppEnvironment): Promise<void> {
  const path = join(environment.workdir, 'environment.json');
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(environment.workdir, { recursive: true });
  try {
    await writeFile(
      temp,
      `${JSON.stringify(AppEnvironmentSchema.parse(environment), null, 2)}\n`,
      'utf8',
    );
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function operationError(
  operation: EnvironmentLifecycleOperation,
  error: unknown,
): EnvironmentOperationError {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const diagnostic =
    [record.stderr, record.stdout, error instanceof Error ? error.message : error]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map(redactDiagnostic)
      .join('\n') || 'Unknown Supabase CLI failure.';
  return new EnvironmentOperationError(
    operation,
    typeof record.exitCode === 'number' ? record.exitCode : undefined,
    capUtf8(diagnostic, MAX_DIAGNOSTIC_BYTES),
  );
}

function redactDiagnostic(value: string): string {
  return redactString(value).replace(
    /((?:["']?[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY)[A-Z0-9_]*["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
    '$1"[REDACTED]"',
  );
}

function capUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString('utf8');
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
