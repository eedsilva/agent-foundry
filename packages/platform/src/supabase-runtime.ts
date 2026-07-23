import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execa } from 'execa';
import {
  AppEnvironmentSchema,
  FunctionArtifactSchema,
  FunctionInvocationResultSchema,
  FunctionVersionSchema,
  MigrationApprovalSchema,
  MigrationBackupSchema,
  MigrationPreviewSchema,
  PathSegmentSchema,
  type AppEnvironment,
  type DestructiveEnvironmentConfirmation,
  type EnvironmentLifecycleOperation,
  type FunctionArtifact,
  type FunctionInvocationResult,
  type FunctionVersion,
  type MigrationApproval,
  type MigrationBackup,
  type MigrationPreview,
} from '@agent-foundry/contracts';
import {
  EnvironmentOperationError,
  ValidationError,
  redactString,
  withSpan,
  type GeneratedProjectRuntime,
} from '@agent-foundry/domain';

const MAX_BACKUP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const PORT_BASE = 20_000;
const PORT_BLOCK_SIZE = 8;
const HOST_PORT_FIELDS = [
  ['api', 'port'],
  ['db', 'port'],
  ['db', 'shadow_port'],
  ['studio', 'port'],
  ['inbucket', 'port'],
  ['edge_runtime', 'inspector_port'],
  ['analytics', 'port'],
] as const;
const PORT_SLOT_COUNT =
  Math.floor((65_535 - PORT_BASE - (HOST_PORT_FIELDS.length - 1)) / PORT_BLOCK_SIZE) + 1;

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
  #configurationQueue = Promise.resolve();

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
    await this.#configure(workdir, composeProjectName);
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

  async previewMigration(input: {
    projectId: string;
    migrationPath: string;
  }): Promise<MigrationPreview> {
    const environment = await this.#require(input.projectId);
    return migrationPreview(environment.workdir, input.migrationPath);
  }

  async backupMigration(input: {
    projectId: string;
    backupPath: string;
  }): Promise<MigrationBackup> {
    const environment = await this.#require(input.projectId);
    const path = await containedOutputFile(environment.workdir, input.backupPath);
    const suffix = randomUUID();
    const schemaPath = `${path}.${suffix}.schema.sql`;
    const dataPath = `${path}.${suffix}.data.sql`;
    try {
      await this.#execute(
        'migrate',
        'db',
        'dump',
        '--workdir',
        environment.workdir,
        '--local',
        '--file',
        schemaPath,
      );
      await this.#execute(
        'migrate',
        'db',
        'dump',
        '--workdir',
        environment.workdir,
        '--local',
        '--data-only',
        '--file',
        dataPath,
      );
      const [schema, data] = await Promise.all([readFile(schemaPath), readFile(dataPath)]);
      const backup = Buffer.concat([
        schema,
        schema.at(-1) === 10 ? Buffer.alloc(0) : Buffer.from('\n'),
        data,
      ]);
      await atomicWrite(path, backup);
      const manifest = MigrationBackupSchema.parse({
        path: input.backupPath,
        checksum: sha256(backup),
        schemaChecksum: sha256(schema),
        dataChecksum: sha256(data),
        createdAt: this.#now().toISOString(),
        manifestId: randomUUID(),
      });
      const manifestPath = backupManifestPath(
        this.#dataDir,
        environment.projectId,
        manifest.manifestId,
      );
      await mkdir(dirname(manifestPath), { recursive: true });
      await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    } finally {
      await Promise.all([rm(schemaPath, { force: true }), rm(dataPath, { force: true })]);
    }
  }

  async migrate(input: {
    projectId: string;
    migrationPath: string;
    approval?: MigrationApproval;
  }): Promise<AppEnvironment> {
    const environment = await this.#require(input.projectId);
    await migrationFile(environment.workdir, input.migrationPath);
    const destructive = (await migrationPreviews(environment.workdir)).filter(
      (preview) => preview.destructiveStatements.length,
    );
    if (destructive.length) {
      await requireMigrationApproval(
        this.#dataDir,
        environment,
        destructive,
        input.approval,
        this.#now(),
      );
    }
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

  async deployFunction(input: {
    projectId: string;
    functionPath: string;
    artifact: FunctionArtifact;
  }): Promise<FunctionVersion> {
    const environment = await this.#require(input.projectId);
    const artifact = FunctionArtifactSchema.parse(input.artifact);
    if (input.functionPath !== `supabase/functions/${artifact.name}`) {
      throw new ValidationError('Function source path must match supabase/functions/<name>.');
    }
    const sourceDir = await requireContainedDirectory(environment.workdir, input.functionPath);
    const files = await collectFunctionFiles(sourceDir);
    if (!files.some((file) => file.relativePath === artifact.entrypoint)) {
      throw new ValidationError(
        `Function entrypoint "${artifact.entrypoint}" was not found in source.`,
      );
    }
    const version = FunctionVersionSchema.parse({
      functionName: artifact.name,
      versionId: randomUUID(),
      checksum: functionChecksum(files),
      artifact,
      createdAt: this.#now().toISOString(),
    });
    await storeFunctionVersion(this.#dataDir, environment.projectId, version, files);
    await activateFunctionVersion(
      this.#dataDir,
      environment.workdir,
      environment.projectId,
      version,
    );
    await this.#touch(environment);
    return version;
  }

  async listFunctionVersions(input: {
    projectId: string;
    functionName: string;
  }): Promise<FunctionVersion[]> {
    const environment = await this.#require(input.projectId);
    return readFunctionVersions(this.#dataDir, environment.projectId, input.functionName);
  }

  async rollbackFunction(input: {
    projectId: string;
    functionName: string;
    versionId: string;
  }): Promise<FunctionVersion> {
    const environment = await this.#require(input.projectId);
    const manifestPath = functionVersionManifestPath(
      this.#dataDir,
      environment.projectId,
      input.functionName,
      input.versionId,
    );
    let version: FunctionVersion;
    try {
      version = FunctionVersionSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    } catch (error) {
      if (isNotFound(error)) {
        throw new ValidationError(`Function version "${input.versionId}" was not found.`);
      }
      throw error;
    }
    const files = await collectFunctionFiles(
      functionVersionFilesDir(
        this.#dataDir,
        environment.projectId,
        input.functionName,
        input.versionId,
      ),
    );
    if (functionChecksum(files) !== version.checksum) {
      throw new ValidationError('Stored function version failed checksum verification.');
    }
    await activateFunctionVersion(
      this.#dataDir,
      environment.workdir,
      environment.projectId,
      version,
    );
    await this.#touch(environment);
    return version;
  }

  async invokeFunction(input: {
    projectId: string;
    functionName: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<FunctionInvocationResult> {
    const environment = await this.#require(input.projectId);
    const versions = await readFunctionVersions(
      this.#dataDir,
      environment.projectId,
      input.functionName,
    );
    const current = versions.at(-1);
    if (!current) {
      throw new ValidationError(`Function "${input.functionName}" has no deployed version.`);
    }
    const apiUrl = environment.endpoints.api;
    if (!apiUrl) {
      throw new EnvironmentOperationError(
        'invoke-function',
        undefined,
        'Environment has no API endpoint.',
      );
    }
    return withSpan(
      'function.invoke',
      { 'function.name': input.functionName, 'project.id': environment.projectId },
      async (span) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), current.artifact.timeoutMs);
        const started = this.#now().getTime();
        try {
          const response = await fetch(`${apiUrl}/functions/v1/${input.functionName}`, {
            method: 'POST',
            ...(input.headers !== undefined ? { headers: input.headers } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            signal: controller.signal,
          });
          const text = await response.text();
          span.setAttribute('http.status_code', response.status);
          return FunctionInvocationResultSchema.parse({
            status: response.status,
            body: text.slice(0, 1_048_576),
            durationMs: this.#now().getTime() - started,
            timedOut: false,
          });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return FunctionInvocationResultSchema.parse({
              status: 504,
              body: '',
              durationMs: this.#now().getTime() - started,
              timedOut: true,
            });
          }
          throw operationError('invoke-function', error);
        } finally {
          clearTimeout(timer);
        }
      },
    );
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

  async #configure(workdir: string, projectId: string): Promise<void> {
    const previous = this.#configurationQueue;
    let release = () => {};
    this.#configurationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await configureProject(this.#dataDir, workdir, projectId);
    } finally {
      release();
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

async function migrationFile(workdir: string, inputPath: string): Promise<string> {
  if (!/^supabase\/migrations\/[^/\\]+\.sql$/.test(inputPath)) {
    throw new ValidationError('Migration must be a supabase/migrations/*.sql artifact.');
  }
  return requireContainedFile(workdir, inputPath);
}

async function migrationPreview(workdir: string, migrationPath: string): Promise<MigrationPreview> {
  const path = await migrationFile(workdir, migrationPath);
  const sql = await readFile(path, 'utf8');
  return MigrationPreviewSchema.parse({
    migrationPath,
    checksum: sha256(sql),
    destructiveStatements: destructiveStatements(sql),
  });
}

async function migrationPreviews(workdir: string): Promise<MigrationPreview[]> {
  const directory = join(workdir, 'supabase', 'migrations');
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.sql'))
    .map((entry) => `supabase/migrations/${entry.name}`)
    .sort();
  return Promise.all(paths.map((path) => migrationPreview(workdir, path)));
}

async function requireContainedFile(workdir: string, inputPath: string): Promise<string> {
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
  return candidate;
}

async function containedOutputFile(workdir: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new ValidationError('Environment file must be a relative path.');
  }
  const candidate = resolve(workdir, inputPath);
  if (!isContained(workdir, candidate)) {
    throw new ValidationError('Environment file must remain inside the project environment.');
  }
  const [resolvedWorkdir, resolvedParent] = await Promise.all([
    realpath(workdir),
    realpath(dirname(candidate)),
  ]);
  if (resolvedParent !== resolvedWorkdir && !isContained(resolvedWorkdir, resolvedParent)) {
    throw new ValidationError('Environment file must remain inside the project environment.');
  }
  try {
    const resolvedCandidate = await realpath(candidate);
    if (!isContained(resolvedWorkdir, resolvedCandidate)) {
      throw new ValidationError('Environment file must remain inside the project environment.');
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  return candidate;
}

async function requireContainedDirectory(workdir: string, inputPath: string): Promise<string> {
  if (isAbsolute(inputPath)) {
    throw new ValidationError('Function source must be a relative path.');
  }
  const candidate = resolve(workdir, inputPath);
  if (!isContained(workdir, candidate)) {
    throw new ValidationError('Function source must remain inside the project environment.');
  }
  const [resolvedWorkdir, resolvedCandidate] = await Promise.all([
    realpath(workdir),
    realpath(candidate),
  ]);
  if (!isContained(resolvedWorkdir, resolvedCandidate)) {
    throw new ValidationError('Function source must remain inside the project environment.');
  }
  return candidate;
}

interface FunctionFile {
  relativePath: string;
  content: Buffer;
}

async function collectFunctionFiles(root: string): Promise<FunctionFile[]> {
  const files: FunctionFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({ relativePath: relative(root, absolute), content: await readFile(absolute) });
      }
    }
  }
  await walk(root);
  if (!files.length) throw new ValidationError('Function source directory contains no files.');
  return files;
}

function functionChecksum(files: FunctionFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(file.content);
  }
  return hash.digest('hex');
}

function functionVersionsDir(dataDir: string, projectId: string, functionName: string): string {
  return join(dataDir, 'projects', projectId, 'functions', functionName, 'versions');
}

function functionVersionManifestPath(
  dataDir: string,
  projectId: string,
  functionName: string,
  versionId: string,
): string {
  return join(functionVersionsDir(dataDir, projectId, functionName), `${versionId}.json`);
}

function functionVersionFilesDir(
  dataDir: string,
  projectId: string,
  functionName: string,
  versionId: string,
): string {
  return join(functionVersionsDir(dataDir, projectId, functionName), versionId);
}

async function storeFunctionVersion(
  dataDir: string,
  projectId: string,
  version: FunctionVersion,
  files: FunctionFile[],
): Promise<void> {
  const versionDir = functionVersionFilesDir(
    dataDir,
    projectId,
    version.functionName,
    version.versionId,
  );
  await mkdir(versionDir, { recursive: true });
  await Promise.all(
    files.map(async (file) => {
      const target = join(versionDir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }),
  );
  await atomicWrite(
    functionVersionManifestPath(dataDir, projectId, version.functionName, version.versionId),
    `${JSON.stringify(version, null, 2)}\n`,
  );
}

async function readFunctionVersions(
  dataDir: string,
  projectId: string,
  functionName: string,
): Promise<FunctionVersion[]> {
  const dir = functionVersionsDir(dataDir, projectId, functionName);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name));
  const versions = await Promise.all(
    manifests.map(async (path) => {
      const [version, stats] = await Promise.all([
        readFile(path, 'utf8').then((raw) => FunctionVersionSchema.parse(JSON.parse(raw))),
        stat(path),
      ]);
      return { version, mtimeMs: stats.mtimeMs };
    }),
  );
  // ponytail: createdAt has ms resolution and a frozen clock can tie; mtimeMs
  // breaks the tie deterministically. Add a write-sequence counter if two
  // real deploys can land in the same millisecond in production.
  return versions
    .sort((a, b) => a.version.createdAt.localeCompare(b.version.createdAt) || a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.version);
}

function liveFunctionDir(workdir: string, functionName: string): string {
  return join(workdir, 'supabase', 'functions', functionName);
}

async function activateFunctionVersion(
  dataDir: string,
  workdir: string,
  projectId: string,
  version: FunctionVersion,
): Promise<void> {
  const versionDir = functionVersionFilesDir(
    dataDir,
    projectId,
    version.functionName,
    version.versionId,
  );
  const liveDir = liveFunctionDir(workdir, version.functionName);
  await rm(liveDir, { recursive: true, force: true });
  await mkdir(liveDir, { recursive: true });
  const files = await collectFunctionFiles(versionDir);
  await Promise.all(
    files.map(async (file) => {
      const target = join(liveDir, file.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }),
  );
  await writeFunctionConfigSection(workdir, version.functionName, version.artifact.verifyJwt);
}

async function writeFunctionConfigSection(
  workdir: string,
  functionName: string,
  verifyJwt: boolean,
): Promise<void> {
  const path = join(workdir, 'supabase', 'config.toml');
  const config = await readFile(path, 'utf8');
  const heading = `[functions.${functionName}]`;
  const lines = config.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    const trimmed = config.endsWith('\n') ? config : `${config}\n`;
    await atomicWrite(path, `${trimmed}\n${heading}\nverify_jwt = ${verifyJwt}\n`);
    return;
  }
  let end = start + 1;
  while (end < lines.length && !/^\[.*\]$/.test(lines[end]!.trim())) end += 1;
  const updated = [
    ...lines.slice(0, start),
    heading,
    `verify_jwt = ${verifyJwt}`,
    ...lines.slice(end),
  ].join('\n');
  await atomicWrite(path, updated);
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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function destructiveStatements(sql: string): string[] {
  const statements = sqlStatements(sql);
  const destructivePatterns = [
    /^DROP\b/i,
    /^TRUNCATE\b/i,
    /^DELETE\s+FROM\b/i,
    /^ALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i,
  ];
  return statements.filter((statement) =>
    destructivePatterns.some((pattern) => pattern.test(statement)),
  );
}

function sqlStatements(sql: string): string[] {
  // ponytail: quote-aware required-pattern scanner; add a SQL parser if syntax coverage expands.
  const statements: string[] = [];
  let statement = '';
  let quoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (quoted) {
      statement += character;
      if (character !== "'") continue;
      if (next === "'") {
        statement += next;
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      statement += character;
      continue;
    }
    if (character === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
      statement += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 1;
      statement += ' ';
      continue;
    }
    if (character === ';') {
      if (statement.trim()) statements.push(statement.trim());
      statement = '';
    } else {
      statement += character;
    }
  }
  if (statement.trim()) statements.push(statement.trim());
  return statements;
}

async function requireMigrationApproval(
  dataDir: string,
  environment: AppEnvironment,
  previews: MigrationPreview[],
  approval: MigrationApproval | undefined,
  now: Date,
): Promise<void> {
  if (!approval) {
    throw new ValidationError('Destructive migration requires approval and verified backup.');
  }
  const parsed = MigrationApprovalSchema.parse(approval);
  const approvedChecksums = new Set([
    parsed.migrationChecksum,
    ...(parsed.migrationChecksums ?? []),
  ]);
  if (previews.some((preview) => !approvedChecksums.has(preview.checksum))) {
    throw new ValidationError(
      'Approved migration changed or approval does not cover every destructive migration in the batch.',
    );
  }
  let manifest: MigrationBackup;
  try {
    const path = backupManifestPath(dataDir, environment.projectId, parsed.backup.manifestId);
    manifest = MigrationBackupSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    throw new ValidationError(
      'Destructive migration requires generated backup manifest provenance.',
    );
  }
  if (JSON.stringify(manifest) !== JSON.stringify(parsed.backup)) {
    throw new ValidationError('Approved backup does not match generated backup provenance.');
  }
  const backupTime = new Date(manifest.createdAt).getTime();
  const age = now.getTime() - backupTime;
  if (!Number.isFinite(backupTime) || age < 0 || age > MAX_BACKUP_AGE_MS) {
    throw new ValidationError('Approved backup must be from the last 24 hours.');
  }
  let backup: Buffer;
  try {
    const path = await requireContainedFile(environment.workdir, manifest.path);
    backup = await readFile(path);
  } catch {
    throw new ValidationError('Approved backup changed or is unavailable.');
  }
  if (sha256(backup) !== manifest.checksum) {
    throw new ValidationError('Approved backup changed after verification.');
  }
}

function backupManifestPath(dataDir: string, projectId: string, manifestId: string): string {
  return join(
    dataDir,
    'migration-backups',
    safeProjectId(projectId),
    `${safeProjectId(manifestId)}.json`,
  );
}

async function persist(environment: AppEnvironment): Promise<void> {
  const path = join(environment.workdir, 'environment.json');
  await atomicWrite(path, `${JSON.stringify(AppEnvironmentSchema.parse(environment), null, 2)}\n`);
}

async function configureProject(
  dataDir: string,
  workdir: string,
  projectId: string,
): Promise<void> {
  const path = join(workdir, 'supabase', 'config.toml');
  try {
    const config = await readFile(path, 'utf8');
    const ports = await allocatePorts(dataDir, workdir, projectId);
    let section = '';
    let foundProjectId = false;
    const foundPorts = new Set<string>();
    const configured = config
      .split('\n')
      .map((line) => {
        const sectionMatch = line.match(/^\[([^\]]+)\]$/);
        if (sectionMatch) {
          section = sectionMatch[1]!;
          return line;
        }
        if (!section && /^project_id\s*=/.test(line)) {
          foundProjectId = true;
          return `project_id = "${projectId}"`;
        }
        const fieldIndex = HOST_PORT_FIELDS.findIndex(
          ([fieldSection, key]) =>
            fieldSection === section && new RegExp(`^${key}\\s*=`).test(line),
        );
        if (fieldIndex === -1) return line;
        const [fieldSection, key] = HOST_PORT_FIELDS[fieldIndex]!;
        foundPorts.add(`${fieldSection}.${key}`);
        return `${key} = ${ports[fieldIndex]}`;
      })
      .join('\n');
    if (!foundProjectId || foundPorts.size !== HOST_PORT_FIELDS.length) {
      throw new Error('Generated Supabase config is missing required project or port fields.');
    }
    await atomicWrite(path, configured);
  } catch (error) {
    throw operationError('initialize', error);
  }
}

async function allocatePorts(
  dataDir: string,
  workdir: string,
  projectId: string,
): Promise<number[]> {
  const used = await usedPorts(dataDir, workdir);
  const preferredSlot =
    createHash('sha256').update(projectId).digest().readUInt32BE(0) % PORT_SLOT_COUNT;
  for (let attempt = 0; attempt < PORT_SLOT_COUNT; attempt += 1) {
    const base = PORT_BASE + ((preferredSlot + attempt) % PORT_SLOT_COUNT) * PORT_BLOCK_SIZE;
    const ports = HOST_PORT_FIELDS.map((_, offset) => base + offset);
    if (ports.every((port) => !used.has(port))) return ports;
  }
  throw new Error('No isolated Supabase host port block is available.');
}

async function usedPorts(dataDir: string, excludingWorkdir: string): Promise<Set<number>> {
  const used = new Set<number>();
  let projects;
  try {
    projects = await readdir(join(dataDir, 'projects'), { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return used;
    throw error;
  }
  await Promise.all(
    projects
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const workdir = environmentDir(dataDir, entry.name);
        if (workdir === excludingWorkdir) return;
        try {
          const config = await readFile(join(workdir, 'supabase', 'config.toml'), 'utf8');
          for (const port of configuredHostPorts(config)) used.add(port);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }),
  );
  return used;
}

function configuredHostPorts(config: string): number[] {
  const ports: number[] = [];
  let section = '';
  for (const line of config.split('\n')) {
    section = line.match(/^\[([^\]]+)\]$/)?.[1] ?? section;
    for (const [fieldSection, key] of HOST_PORT_FIELDS) {
      if (fieldSection !== section) continue;
      const value = line.match(new RegExp(`^${key}\\s*=\\s*(\\d+)$`))?.[1];
      if (value) ports.push(Number(value));
    }
  }
  return ports;
}

async function atomicWrite(path: string, value: string | Buffer): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value);
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
  return redactString(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, '$1[REDACTED]$2')
    .replace(
      /((?:["']?[A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|KEY)[A-Z0-9_]*["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi,
      '$1"[REDACTED]"',
    );
}

function capUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end > maxBytes - 4; end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      // Try the previous byte boundary.
    }
  }
  return '';
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
