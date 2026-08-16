// Bridges the local Supabase stack's connection credentials into the
// generated app's per-project .env (packages/persistence/src/secret-store.ts,
// ADR 0033), so NodePreviewRunner can inject them into the dev-server
// subprocess the same way it does operator-set secrets. See ADR 0034.

export interface SupabaseAppCredentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

/**
 * Extracts the local connection credentials from `supabase status --output
 * json` stdout.
 *
 * Throws rather than returning `undefined` for an unparseable payload or a
 * missing/invalid field (R4, #560): a silent `undefined` here used to make
 * `#initialize` skip writing app secrets with no error, no log, and no
 * event, so the preview came up without them and failed much later with an
 * unrelated "Invalid login credentials". The thrown message names the
 * offending field *names* only — never a field's value — matching the
 * redaction rules the runtime's diagnostic path already enforces.
 */
export function credentialsFromStatus(stdout: string): SupabaseAppCredentials {
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch (cause) {
    throw new Error('supabase status --output json did not return valid JSON.', { cause });
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('supabase status --output json did not return a JSON object.');
  }
  const source = status as Record<string, unknown>;
  const apiUrl = source.API_URL;
  const anonKey = source.ANON_KEY;
  const serviceRoleKey = source.SERVICE_ROLE_KEY;
  const invalid: string[] = [];
  if (typeof apiUrl !== 'string' || !URL.canParse(apiUrl)) invalid.push('API_URL');
  if (typeof anonKey !== 'string' || !anonKey) invalid.push('ANON_KEY');
  if (typeof serviceRoleKey !== 'string' || !serviceRoleKey) invalid.push('SERVICE_ROLE_KEY');
  if (invalid.length > 0) {
    throw new Error(
      `supabase status --output json is missing or has an invalid value for required field(s) ${invalid.join(', ')}.`,
    );
  }
  return {
    apiUrl: apiUrl as string,
    anonKey: anonKey as string,
    serviceRoleKey: serviceRoleKey as string,
  };
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
