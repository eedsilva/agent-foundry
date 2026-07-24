// Shared HTTP helpers for the real-stack e2e suites
// (supabase-storage.e2e.test.ts, supabase-auth.e2e.test.ts) that drive a
// live local Supabase stack over its REST/Auth APIs. Test-only: not
// exported from index.ts, so it never ships in the package's built dist.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FETCH_TIMEOUT_MS = 60_000;

export interface Credentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwtSecret: string;
}

export async function readCredentials(workdir: string, timeoutMs: number): Promise<Credentials> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'supabase',
      ['status', '--output', 'json', '--workdir', workdir],
      { encoding: 'utf8', timeout: timeoutMs },
    ));
  } catch {
    throw new Error('Supabase status failed.');
  }
  let status: unknown;
  try {
    status = JSON.parse(stdout);
  } catch {
    throw new Error('Supabase status returned invalid JSON.');
  }
  if (!isRecord(status)) throw new Error('Supabase status omitted required local credentials.');
  const apiUrl = status.API_URL;
  const anonKey = status.ANON_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY;
  const jwtSecret = status.JWT_SECRET;
  if (
    typeof apiUrl !== 'string' ||
    !URL.canParse(apiUrl) ||
    typeof anonKey !== 'string' ||
    typeof serviceRoleKey !== 'string' ||
    typeof jwtSecret !== 'string'
  ) {
    throw new Error('Supabase status omitted required local credentials.');
  }
  return { apiUrl, anonKey, serviceRoleKey, jwtSecret };
}

export function authHeaders(apiKey: string, token: string): Record<string, string> {
  return { apikey: apiKey, Authorization: `Bearer ${token}` };
}

export function boundedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

export function requireOk(response: Response, operation: string): Response {
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }
  return response;
}

export async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('Local Supabase returned invalid JSON.');
  }
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('PostgREST returned an invalid row set.');
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
