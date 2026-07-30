export interface SupabaseDataPlaneConfig {
  databaseUrl: string;
  s3Endpoint: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
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
