import { createHash } from 'node:crypto';

export interface SupabaseDataPlaneConfig {
  databaseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
}

const LOCAL_SUPABASE_PORT_BASE = 20_000;
const LOCAL_SUPABASE_PORT_BLOCK_SIZE = 8;
export const LOCAL_SUPABASE_HOST_PORT_FIELDS = [
  { envVar: 'SUPABASE_API_PORT', section: 'api', key: 'port' },
  { envVar: 'SUPABASE_DB_PORT', section: 'db', key: 'port' },
  { envVar: 'SUPABASE_DB_SHADOW_PORT', section: 'db', key: 'shadow_port' },
  { envVar: 'SUPABASE_STUDIO_PORT', section: 'studio', key: 'port' },
  { envVar: 'SUPABASE_INBUCKET_PORT', section: 'inbucket', key: 'port' },
  {
    envVar: 'SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT',
    section: 'edge_runtime',
    key: 'inspector_port',
  },
] as const;
const LOCAL_SUPABASE_PORT_SLOT_COUNT =
  Math.floor(
    (65_535 - LOCAL_SUPABASE_PORT_BASE - (LOCAL_SUPABASE_HOST_PORT_FIELDS.length - 1)) /
      LOCAL_SUPABASE_PORT_BLOCK_SIZE,
  ) + 1;

export type CleanupStep = { label: string; run: () => Promise<void> | void };

export function isMissingS3ResourceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    name?: string;
    code?: string;
    Code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NoSuchBucket' ||
    candidate.code === 'NoSuchBucket' ||
    candidate.Code === 'NoSuchBucket' ||
    candidate.$metadata?.httpStatusCode === 404 ||
    candidate.message === 'The related resource does not exist'
  );
}

export function parseShellEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || !line.includes('=')) continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) continue;
    values[key] = stripQuotes(rawValue.trim());
  }
  return values;
}

export function localSupabaseDataPlaneConfigFromStatusEnv(text: string): SupabaseDataPlaneConfig {
  const env = text.trimStart().startsWith('{') ? JSON.parse(text) : parseShellEnv(text);
  const apiUrl = requireValue(env, 'API_URL', 'Supabase status');
  return {
    databaseUrl: requireValue(env, 'DB_URL', 'Supabase status'),
    s3Endpoint: new URL('/storage/v1/s3', apiUrl).toString(),
    s3Region: requireValue(env, 'S3_PROTOCOL_REGION', 'Supabase status'),
    s3AccessKeyId: requireValue(env, 'S3_PROTOCOL_ACCESS_KEY_ID', 'Supabase status'),
    s3SecretAccessKey: requireValue(env, 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'Supabase status'),
  };
}

export function hostedSupabaseDataPlaneConfigFromEnv(
  env: NodeJS.ProcessEnv,
): SupabaseDataPlaneConfig {
  return {
    databaseUrl: requireValue(env, 'DATABASE_URL', 'process env'),
    s3Endpoint: requireValue(env, 'S3_ENDPOINT', 'process env'),
    s3Region: requireValue(env, 'S3_REGION', 'process env'),
    s3AccessKeyId: requireValue(env, 'S3_ACCESS_KEY_ID', 'process env'),
    s3SecretAccessKey: requireValue(env, 'S3_SECRET_ACCESS_KEY', 'process env'),
  };
}

export function assertMigrationCapableDatabaseUrl(databaseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return;
  }
  if (parsed.port === '6543') {
    throw new Error(
      'Supabase data-plane validation runs repository migrations and therefore requires a direct connection or the session pooler (5432), not the transaction pooler (6543).',
    );
  }
}

export function buildLocalSupabaseConfig(): string {
  return `project_id = "env(SUPABASE_PROJECT_ID)"

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
port = "env(SUPABASE_INBUCKET_PORT)"

[realtime]
enabled = false

[edge_runtime]
enabled = false
inspector_port = "env(SUPABASE_EDGE_RUNTIME_INSPECTOR_PORT)"
`;
}

export async function allocateLocalSupabasePorts(
  projectId: string,
  isPortFree: (port: number) => Promise<boolean>,
): Promise<Record<(typeof LOCAL_SUPABASE_HOST_PORT_FIELDS)[number]['envVar'], number>> {
  const preferredSlot =
    createHash('sha256').update(projectId).digest().readUInt32BE(0) %
    LOCAL_SUPABASE_PORT_SLOT_COUNT;
  for (let attempt = 0; attempt < LOCAL_SUPABASE_PORT_SLOT_COUNT; attempt += 1) {
    const base =
      LOCAL_SUPABASE_PORT_BASE +
      ((preferredSlot + attempt) % LOCAL_SUPABASE_PORT_SLOT_COUNT) * LOCAL_SUPABASE_PORT_BLOCK_SIZE;
    const ports = LOCAL_SUPABASE_HOST_PORT_FIELDS.map((_, offset) => base + offset);
    if (!(await Promise.all(ports.map((port) => isPortFree(port)))).every(Boolean)) continue;
    return Object.fromEntries(
      LOCAL_SUPABASE_HOST_PORT_FIELDS.map((field, index) => [field.envVar, ports[index]]),
    ) as Record<(typeof LOCAL_SUPABASE_HOST_PORT_FIELDS)[number]['envVar'], number>;
  }
  throw new Error('No isolated Supabase host port block is available.');
}

export async function runCleanupSteps(steps: CleanupStep[]): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      failures.push(new Error(`Cleanup failed for ${step.label}: ${cause.message}`));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Supabase data-plane cleanup failed (${failures.length} step${failures.length === 1 ? '' : 's'}).`,
    );
  }
}

function requireValue(
  source: Record<string, string | undefined>,
  key: string,
  sourceName: string,
): string {
  const value = source[key];
  if (!value) {
    throw new Error(`${sourceName} omitted required variable ${key}.`);
  }
  return value;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
