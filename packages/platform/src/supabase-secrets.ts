// Bridges the local Supabase stack's connection credentials into the
// generated app's per-project .env (packages/persistence/src/secret-store.ts,
// ADR 0033), so NodePreviewRunner can inject them into the dev-server
// subprocess the same way it does operator-set secrets. See ADR 0034.

export interface SupabaseAppCredentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

/** Extracts the local connection credentials from `supabase status --output json` stdout. */
export function credentialsFromStatus(stdout: string): SupabaseAppCredentials | undefined {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined;
  const source = status as Record<string, unknown>;
  const apiUrl = source.API_URL;
  const anonKey = source.ANON_KEY;
  const serviceRoleKey = source.SERVICE_ROLE_KEY;
  if (
    typeof apiUrl !== 'string' ||
    !URL.canParse(apiUrl) ||
    typeof anonKey !== 'string' ||
    !anonKey ||
    typeof serviceRoleKey !== 'string' ||
    !serviceRoleKey
  ) {
    return undefined;
  }
  return { apiUrl, anonKey, serviceRoleKey };
}

const UNQUOTED_SAFE = /^[\w.\-:/@?=&%+]*$/;

function formatEnvValue(value: string): string {
  if (UNQUOTED_SAFE.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Overwrites (or appends) the given KEY=value pairs in a .env file's text,
 * leaving every other line untouched — an operator's own secrets survive
 * being written next to the platform-managed keys. Line-based rather than a
 * full dotenv round-trip: the only thing this ever needs to preserve is
 * "everything that isn't one of these specific keys," which a full parser
 * would not do any more precisely.
 */
export function upsertEnvVars(existing: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const updatedLines = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    const key = match?.[1];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });
  while (updatedLines.length && updatedLines[updatedLines.length - 1] === '') updatedLines.pop();
  for (const [key, value] of remaining) {
    updatedLines.push(`${key}=${formatEnvValue(value)}`);
  }
  return updatedLines.length ? `${updatedLines.join('\n')}\n` : '';
}
