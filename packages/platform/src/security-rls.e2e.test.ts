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
const PROJECT_ID = 'project-rls';
const STOP_TIMEOUT_MS = 60_000;

// A real table exercising the owner-RLS baseline documented in
// harness/stacks/supabase.md and templated in
// harness/scaffolds/nextjs/supabase/migrations/00000000000001_rls_baseline_example.sql
// — same shape as supabase-auth.e2e.test.ts's RLS_MIGRATION, duplicated here
// (not shared) so this file stays self-contained like its sibling.
//
// This repo's generated-app auth/authorization model is single-owner
// (user_id/owner_id -> auth.uid()): there is no member/admin/tenant role, so
// a member/admin tier of this access matrix is N/A for the current baseline
// — this satisfies issue #75's acceptance criterion "when applicable" for
// the roles it doesn't have.
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

describe.runIf(process.env.RUN_SUPABASE_RLS_E2E === 'true')(
  'generated Supabase RLS access matrix',
  () => {
    let dataDir: string;
    let workdir: string;
    let credentials: Credentials;

    beforeAll(
      async () => {
        dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-rls-'));
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
        // PostgREST reloads its schema cache asynchronously after a
        // migration lands, so the new `items` table can 404 for a short
        // window right after migrate() resolves. Poll with the
        // service-role key (bypasses RLS, only proves the table is visible
        // to PostgREST) instead of racing it in every test below.
        await waitForSchemaCache(credentials);
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

    it('denies anonymous SELECT on items (RLS is to authenticated only)', async () => {
      const email = `rls-${randomUUID()}@example.test`;
      const password = `Rls-${randomUUID()}-Aa1!`;
      await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();
      const session = await login(credentials, email, password);
      await requireOk(
        await insertItem(credentials, session, 'owned by authenticated user'),
        'insert as owner',
      ).arrayBuffer();

      // Anon key only, no bearer session token — this is what an
      // unauthenticated visitor's request looks like.
      const response = await boundedFetch(`${credentials.apiUrl}/rest/v1/items?select=title`, {
        headers: authHeaders(credentials.anonKey, credentials.anonKey),
      });
      if (response.ok) {
        const anonRows = rows(await json(response));
        expect(anonRows).toHaveLength(0);
      } else {
        await response.arrayBuffer();
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
      }
    }, 30_000);

    it('denies anonymous INSERT on items (RLS is to authenticated only)', async () => {
      const response = await boundedFetch(`${credentials.apiUrl}/rest/v1/items`, {
        method: 'POST',
        headers: {
          ...authHeaders(credentials.anonKey, credentials.anonKey),
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ title: 'anon should not be able to insert this' }),
      });
      await response.arrayBuffer();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }, 30_000);

    it('lets an owner read and write their own rows', async () => {
      const email = `rls-${randomUUID()}@example.test`;
      const password = `Rls-${randomUUID()}-Aa1!`;
      await requireOk(await signUp(credentials, email, password), 'sign up').arrayBuffer();
      const session = await login(credentials, email, password);

      const inserted = rows(
        await json(
          requireOk(await insertItem(credentials, session, 'my own item'), 'insert own row'),
        ),
      );
      expect(inserted).toHaveLength(1);

      const listed = rows(
        await json(requireOk(await listItems(credentials, session), 'list own rows')),
      );
      expect(listed.some((row) => row.title === 'my own item')).toBe(true);
    }, 30_000);

    it("denies a cross-owner UPDATE (IDOR): owner B's PATCH on owner A's row has no effect", async () => {
      const emailA = `rls-${randomUUID()}@example.test`;
      const emailB = `rls-${randomUUID()}@example.test`;
      const password = `Rls-${randomUUID()}-Aa1!`;
      await requireOk(await signUp(credentials, emailA, password), 'sign up A').arrayBuffer();
      await requireOk(await signUp(credentials, emailB, password), 'sign up B').arrayBuffer();
      const sessionA = await login(credentials, emailA, password);
      const sessionB = await login(credentials, emailB, password);

      const insertedRows = rows(
        await json(
          requireOk(await insertItem(credentials, sessionA, 'owned by A'), 'insert as owner A'),
        ),
      );
      expect(insertedRows).toHaveLength(1);
      const itemId = insertedRows[0]?.id;
      expect(typeof itemId).toBe('string');

      // B has no visible row matching this id under RLS, so PostgREST
      // filters it out of the update's candidate set: the request itself
      // does not error, it just affects zero rows. Assert on the effect
      // (unchanged content when re-read as A), not just the HTTP status.
      const updateResponse = await updateItem(credentials, sessionB, itemId as string, {
        title: 'hijacked by B',
      });
      await updateResponse.arrayBuffer();

      const rowsForAAfter = rows(
        await json(requireOk(await listItems(credentials, sessionA), 'list as A after B PATCH')),
      );
      expect(rowsForAAfter.some((row) => row.title === 'owned by A')).toBe(true);
      expect(rowsForAAfter.some((row) => row.title === 'hijacked by B')).toBe(false);
    }, 30_000);

    it("denies a cross-owner DELETE (IDOR): owner B's DELETE on owner A's row has no effect", async () => {
      const emailA = `rls-${randomUUID()}@example.test`;
      const emailB = `rls-${randomUUID()}@example.test`;
      const password = `Rls-${randomUUID()}-Aa1!`;
      await requireOk(await signUp(credentials, emailA, password), 'sign up A').arrayBuffer();
      await requireOk(await signUp(credentials, emailB, password), 'sign up B').arrayBuffer();
      const sessionA = await login(credentials, emailA, password);
      const sessionB = await login(credentials, emailB, password);

      const insertedRows = rows(
        await json(
          requireOk(
            await insertItem(credentials, sessionA, 'owned by A, targeted for delete'),
            'insert as owner A',
          ),
        ),
      );
      expect(insertedRows).toHaveLength(1);
      const itemId = insertedRows[0]?.id;
      expect(typeof itemId).toBe('string');

      const deleteResponse = await deleteItem(credentials, sessionB, itemId as string);
      await deleteResponse.arrayBuffer();

      const rowsForAAfter = rows(
        await json(requireOk(await listItems(credentials, sessionA), 'list as A after B DELETE')),
      );
      expect(rowsForAAfter.some((row) => row.title === 'owned by A, targeted for delete')).toBe(
        true,
      );
    }, 30_000);

    it("rejects INSERT with a spoofed user_id (privilege escalation via the migration's with check)", async () => {
      const emailA = `rls-${randomUUID()}@example.test`;
      const emailB = `rls-${randomUUID()}@example.test`;
      const password = `Rls-${randomUUID()}-Aa1!`;
      await requireOk(await signUp(credentials, emailA, password), 'sign up A').arrayBuffer();
      await requireOk(await signUp(credentials, emailB, password), 'sign up B').arrayBuffer();
      const sessionA = await login(credentials, emailA, password);
      const sessionB = await login(credentials, emailB, password);

      // B is authenticated (valid session) but claims A's user_id on
      // insert. The migration's `with check (user_id = (select auth.uid()))`
      // must reject this outright — not silently attribute the row to B.
      const response = await boundedFetch(`${credentials.apiUrl}/rest/v1/items`, {
        method: 'POST',
        headers: {
          ...authHeaders(credentials.anonKey, sessionB.accessToken),
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ title: 'spoofed onto A', user_id: sessionA.userId }),
      });
      await response.arrayBuffer();
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);

      const rowsForAAfter = rows(
        await json(
          requireOk(await listItems(credentials, sessionA), 'list as A after spoof attempt'),
        ),
      );
      expect(rowsForAAfter.some((row) => row.title === 'spoofed onto A')).toBe(false);
    }, 30_000);
  },
);

async function waitForSchemaCache(credentials: Credentials, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await boundedFetch(`${credentials.apiUrl}/rest/v1/items?select=id&limit=1`, {
      headers: authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
    });
    await response.arrayBuffer();
    if (response.status !== 404) return;
    if (Date.now() > deadline) {
      throw new Error("PostgREST never picked up the 'items' table from its schema cache.");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

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
  return boundedFetch(`${credentials.apiUrl}/rest/v1/items?select=id,title`, {
    headers: authHeaders(credentials.anonKey, session.accessToken),
  });
}

function updateItem(
  credentials: Credentials,
  session: Session,
  itemId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/rest/v1/items?id=eq.${itemId}`, {
    method: 'PATCH',
    headers: {
      ...authHeaders(credentials.anonKey, session.accessToken),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });
}

function deleteItem(credentials: Credentials, session: Session, itemId: string): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/rest/v1/items?id=eq.${itemId}`, {
    method: 'DELETE',
    headers: {
      ...authHeaders(credentials.anonKey, session.accessToken),
      Prefer: 'return=representation',
    },
  });
}
