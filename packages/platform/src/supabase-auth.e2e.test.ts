import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SupabaseGeneratedProjectRuntime } from './supabase-runtime.js';
import {
  authHeaders,
  boundedFetch,
  isRecord,
  json,
  readCredentials,
  requireOk,
  rows,
  type Credentials,
} from './e2e-test-support.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'project-a';
const STOP_TIMEOUT_MS = 60_000;

// A real table exercising the owner-RLS baseline documented in
// harness/stacks/supabase.md and templated in
// harness/scaffolds/nextjs/supabase/migrations/00000000000001_rls_baseline_example.sql
// — that scaffold file is a commented-out template, so the "access denied"
// case here applies the same pattern for real against a live table.
const RLS_MIGRATION = `create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  title text not null
);

alter table public.items enable row level security;

create policy items_select_owner
  on public.items for select to authenticated
  using (user_id = (select auth.uid()));

create policy items_insert_owner
  on public.items for insert to authenticated
  with check (user_id = (select auth.uid()));
`;

interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
}

describe.runIf(process.env.RUN_SUPABASE_AUTH_E2E === 'true')('generated Supabase auth', () => {
  let dataDir: string;
  let workdir: string;
  let credentials: Credentials;

  beforeAll(
    async () => {
      dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-auth-'));
      workdir = join(dataDir, 'projects', PROJECT_ID, 'environment');
      const runtime = new SupabaseGeneratedProjectRuntime({ dataDir });
      await runtime.initialize({ projectId: PROJECT_ID });
      credentials = await readCredentials(workdir, STOP_TIMEOUT_MS);
      await mkdir(join(workdir, 'supabase', 'migrations'), { recursive: true });
      await writeFile(
        join(workdir, 'supabase', 'migrations', '00000000000002_items.sql'),
        RLS_MIGRATION,
      );
      await runtime.migrate({
        projectId: PROJECT_ID,
        migrationPath: 'supabase/migrations/00000000000002_items.sql',
      });
    },
    5 * 60 * 1000,
  );

  afterAll(async () => {
    try {
      await access(workdir);
    } catch {
      return;
    }
    try {
      await execFileAsync('supabase', ['stop', '--workdir', workdir, '--no-backup', '--yes'], {
        encoding: 'utf8',
        timeout: STOP_TIMEOUT_MS,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, STOP_TIMEOUT_MS + 10_000);

  it('signs up a new user and returns an active session immediately (no email confirmation)', async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;

    await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();

    // The strongest proof signup created a real, immediately usable
    // account (no email confirmation gate) is that the same credentials
    // can log in right away — GoTrue's own signup response envelope
    // shape varies by whether autoconfirm is active, so assert behavior
    // instead of a specific response body shape.
    const session = await login(credentials, email, password);
    expect(session.accessToken.length).toBeGreaterThan(0);
  }, 30_000);

  it('logs an existing user in with email and password', async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;
    await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();

    const session = await login(credentials, email, password);

    expect(typeof session.accessToken).toBe('string');
    expect(session.accessToken.length).toBeGreaterThan(0);
  }, 30_000);

  it('lets an administrator reset a user password with the service-role key, no self-service reset', async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const oldPassword = `Auth-${randomUUID()}-Aa1!`;
    const newPassword = `Auth-${randomUUID()}-Bb2!`;
    await requireOk(await signUp(credentials, email, oldPassword), 'sign up').arrayBuffer();
    const session = await login(credentials, email, oldPassword);

    // Mirrors docs/OPERATIONS.md's "Generated-app auth and RLS baseline"
    // admin reset procedure: only the service-role key can do this, and it
    // is not exposed as an app route.
    await requireOk(
      await adminResetPassword(credentials, session.userId, newPassword),
      'admin password reset',
    ).arrayBuffer();

    await expectClientError(
      await requestLogin(credentials, email, oldPassword),
      'login with the old password after admin reset',
    );
    const newSession = await login(credentials, email, newPassword);
    expect(newSession.accessToken.length).toBeGreaterThan(0);
  }, 30_000);

  it('invalidates the refresh token on logout so a new session cannot be minted', async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;
    await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();
    const session = await login(credentials, email, password);

    await requireOk(await logout(credentials, session), 'logout').arrayBuffer();

    await expectClientError(
      await refreshSession(credentials, session.refreshToken),
      'refresh after logout',
    );
  }, 30_000);

  it('rejects an expired session token against a protected endpoint', async () => {
    const email = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;
    await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();
    const session = await login(credentials, email, password);
    const expiredToken = signExpiredToken(credentials.jwtSecret, session.userId);

    await expectClientError(await getSelf(credentials, expiredToken), 'expired session read');
  }, 30_000);

  it("denies reading another owner's row under RLS", async () => {
    const emailA = `auth-${randomUUID()}@example.test`;
    const emailB = `auth-${randomUUID()}@example.test`;
    const password = `Auth-${randomUUID()}-Aa1!`;
    await requireOk(await signUp(credentials, emailA, password), 'sign up A').arrayBuffer();
    await requireOk(await signUp(credentials, emailB, password), 'sign up B').arrayBuffer();
    const sessionA = await login(credentials, emailA, password);
    const sessionB = await login(credentials, emailB, password);

    const inserted = await json(
      requireOk(await insertItem(credentials, sessionA, 'owned by A'), 'insert as owner A'),
    );
    const rowsForA = rows(inserted);
    expect(rowsForA).toHaveLength(1);

    const rowsForB = rows(
      await json(requireOk(await listItems(credentials, sessionB), 'list as B')),
    );
    expect(rowsForB.some((row) => row.title === 'owned by A')).toBe(false);

    const rowsForAAgain = rows(
      await json(requireOk(await listItems(credentials, sessionA), 'list as A')),
    );
    expect(rowsForAAgain.some((row) => row.title === 'owned by A')).toBe(true);
  }, 30_000);
});

function signUp(credentials: Credentials, email: string, password: string): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, credentials.anonKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
}

function requestLogin(
  credentials: Credentials,
  email: string,
  password: string,
): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, credentials.anonKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
}

async function login(credentials: Credentials, email: string, password: string): Promise<Session> {
  const response = requireOk(await requestLogin(credentials, email, password), 'login');
  const payload = await json(response);
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    typeof payload.refresh_token !== 'string' ||
    !isRecord(payload.user) ||
    typeof payload.user.id !== 'string'
  ) {
    throw new Error('Local Auth returned an invalid session.');
  }
  return {
    userId: payload.user.id,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
  };
}

function adminResetPassword(
  credentials: Credentials,
  userId: string,
  newPassword: string,
): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: {
      ...authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: newPassword }),
  });
}

function logout(credentials: Credentials, session: Session): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/logout`, {
    method: 'POST',
    headers: authHeaders(credentials.anonKey, session.accessToken),
  });
}

function refreshSession(credentials: Credentials, refreshToken: string): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, credentials.anonKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
}

function getSelf(credentials: Credentials, token: string): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/auth/v1/user`, {
    headers: authHeaders(credentials.anonKey, token),
  });
}

function insertItem(credentials: Credentials, session: Session, title: string): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/rest/v1/items`, {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, session.accessToken),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ title, user_id: session.userId }),
  });
}

function listItems(credentials: Credentials, session: Session): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/rest/v1/items?select=title`, {
    headers: authHeaders(credentials.anonKey, session.accessToken),
  });
}

/**
 * Hand-builds an HS256 JWT already past its `exp`, signed with the local
 * stack's real JWT_SECRET, so it verifies structurally but PostgREST/GoTrue
 * must still reject it on expiry — a real expired-session token rather than
 * a merely malformed one, without waiting out a real token lifetime in CI.
 */
function signExpiredToken(secret: string, userId: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) - 3600,
    }),
  );
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function expectClientError(response: Response, operation: string): Promise<void> {
  await response.arrayBuffer();
  if (response.status < 400 || response.status >= 500) {
    throw new Error(
      `${operation} expected an HTTP 4xx client error; received HTTP ${response.status}.`,
    );
  }
}
