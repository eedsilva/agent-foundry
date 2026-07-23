import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SupabaseGeneratedProjectRuntime } from './supabase-runtime.js';
import { GENERATED_STORAGE_BUCKET, GENERATED_STORAGE_MAX_BYTES } from './supabase-storage.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'project-a';

interface Credentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

interface User {
  id: string;
  accessToken: string;
}

describe.runIf(process.env.RUN_SUPABASE_STORAGE_E2E === 'true')(
  'generated Supabase Storage',
  () => {
    it(
      'enforces RLS, quarantine, limits, export, and cleanup on the real local stack',
      async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-storage-'));
        const workdir = join(dataDir, 'projects', PROJECT_ID, 'environment');
        const runtime = new SupabaseGeneratedProjectRuntime({ dataDir });
        const objectNames = new Set<string>();
        let credentials: Credentials | undefined;

        try {
          await runtime.initialize({ projectId: PROJECT_ID });
          credentials = await readCredentials(workdir);
          const userA = await createUser(credentials);
          const userB = await createUser(credentials);
          const allowedBytes = new TextEncoder().encode(`allowed-${randomUUID()}`);
          const objectName = `${userA.id}/allowed.png`;
          objectNames.add(objectName);

          await requireOk(
            await rpc(credentials, userA.accessToken, 'prepare_storage_upload', {
              p_object_name: objectName,
              p_media_type: 'image/png',
              p_size_bytes: allowedBytes.byteLength,
            }),
            'prepare allowed upload',
          ).arrayBuffer();
          await requireOk(
            await uploadObject(
              credentials,
              userA.accessToken,
              objectName,
              'image/png',
              allowedBytes,
            ),
            'upload allowed object',
          ).arrayBuffer();

          await expectDenied(
            await signObject(credentials, userA.accessToken, objectName),
            'quarantined signed URL',
          );
          await requireOk(
            await rpc(credentials, credentials.serviceRoleKey, 'complete_storage_scan', {
              p_object_name: objectName,
              p_status: 'clean',
            }),
            'complete scan',
          ).arrayBuffer();

          const cleanSignedUrl = await createSignedUrl(credentials, userA.accessToken, objectName);
          expect(await fetchSignedBytes(cleanSignedUrl)).toEqual(allowedBytes);
          await expectDenied(
            await signObject(credentials, userB.accessToken, objectName),
            'cross-owner signed URL',
          );
          await expectDenied(
            await fetch(storageObjectUrl(credentials.apiUrl, 'authenticated', objectName), {
              headers: authHeaders(credentials.anonKey, userB.accessToken),
            }),
            'cross-owner object fetch',
          );

          const oversizedDeclaration = `${userA.id}/declared-oversized.png`;
          const wrongTypeDeclaration = `${userA.id}/declared-wrong-type.txt`;
          await expectDenied(
            await rpc(credentials, userA.accessToken, 'prepare_storage_upload', {
              p_object_name: oversizedDeclaration,
              p_media_type: 'image/png',
              p_size_bytes: GENERATED_STORAGE_MAX_BYTES + 1,
            }),
            'oversized upload declaration',
          );
          await expectDenied(
            await rpc(credentials, userA.accessToken, 'prepare_storage_upload', {
              p_object_name: wrongTypeDeclaration,
              p_media_type: 'text/plain',
              p_size_bytes: 1,
            }),
            'wrong MIME upload declaration',
          );
          expect(await metadataRows(credentials, oversizedDeclaration)).toHaveLength(0);
          expect(await metadataRows(credentials, wrongTypeDeclaration)).toHaveLength(0);

          const oversizedObject = `${userA.id}/native-oversized.png`;
          const wrongTypeObject = `${userA.id}/native-wrong-type.txt`;
          objectNames.add(oversizedObject);
          objectNames.add(wrongTypeObject);
          await expectNativeLimitRejection(
            credentials,
            oversizedObject,
            'image/png',
            new Uint8Array(GENERATED_STORAGE_MAX_BYTES + 1),
          );
          await expectNativeLimitRejection(
            credentials,
            wrongTypeObject,
            'text/plain',
            new TextEncoder().encode('not allowed'),
          );

          const manifest = rows(
            await json(
              requireOk(
                await rpc(credentials, userA.accessToken, 'storage_export_manifest', {}),
                'export manifest',
              ),
            ),
          );
          expect(manifest.some((row) => row.object_name === objectName)).toBe(true);
          const exportSignedUrl = await createSignedUrl(credentials, userA.accessToken, objectName);
          const exportedBytes = Uint8Array.from(await fetchSignedBytes(exportSignedUrl));
          expect(exportedBytes).toEqual(allowedBytes);

          const confirmedExport = rows(
            await json(
              requireOk(
                await rpc(credentials, userA.accessToken, 'confirm_storage_export', {
                  p_object_names: [objectName],
                }),
                'confirm export',
              ),
            ),
          );
          expect(confirmedExport.some((row) => row.object_name === objectName)).toBe(true);

          const expired = rows(
            await json(
              requireOk(
                await fetch(
                  `${credentials.apiUrl}/rest/v1/storage_uploads?object_name=eq.${encodeURIComponent(objectName)}`,
                  {
                    method: 'PATCH',
                    headers: {
                      ...authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
                      'Content-Type': 'application/json',
                      Prefer: 'return=representation',
                    },
                    body: JSON.stringify({ retain_until: new Date(0).toISOString() }),
                  },
                ),
                'expire upload metadata',
              ),
            ),
          );
          expect(expired.some((row) => row.object_name === objectName)).toBe(true);

          const candidates = rows(
            await json(
              requireOk(
                await rpc(
                  credentials,
                  credentials.serviceRoleKey,
                  'storage_cleanup_candidates',
                  {},
                ),
                'list cleanup candidates',
              ),
            ),
          );
          expect(candidates.some((row) => row.object_name === objectName)).toBe(true);

          await requireOk(
            await deleteObject(credentials, objectName),
            'delete exported object bytes',
          ).arrayBuffer();
          await requireOk(
            await rpc(credentials, credentials.serviceRoleKey, 'confirm_storage_cleanup', {
              p_object_name: objectName,
            }),
            'confirm metadata cleanup',
          ).arrayBuffer();
          expect(await metadataRows(credentials, objectName)).toHaveLength(0);
        } finally {
          if (credentials) {
            const cleanupCredentials = credentials;
            await Promise.all(
              [...objectNames].map(async (objectName) => {
                try {
                  const response = await deleteObject(cleanupCredentials, objectName);
                  await response.arrayBuffer();
                } catch {
                  // The exact workdir stop below remains authoritative cleanup.
                }
              }),
            );
          }
          await execFileAsync('supabase', [
            'stop',
            '--workdir',
            workdir,
            '--no-backup',
            '--yes',
          ]).catch(() => undefined);
          await rm(dataDir, { recursive: true, force: true });
        }
      },
      12 * 60 * 1000,
    );
  },
);

async function readCredentials(workdir: string): Promise<Credentials> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'supabase',
      ['status', '--output', 'json', '--workdir', workdir],
      { encoding: 'utf8' },
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
  if (
    typeof apiUrl !== 'string' ||
    !URL.canParse(apiUrl) ||
    typeof anonKey !== 'string' ||
    typeof serviceRoleKey !== 'string'
  ) {
    throw new Error('Supabase status omitted required local credentials.');
  }
  return { apiUrl, anonKey, serviceRoleKey };
}

async function createUser(credentials: Credentials): Promise<User> {
  const suffix = randomUUID();
  const email = `storage-${suffix}@example.test`;
  const password = `Storage-${suffix}-Aa1!`;
  const headers = {
    ...authHeaders(credentials.anonKey, credentials.anonKey),
    'Content-Type': 'application/json',
  };
  await requireOk(
    await fetch(`${credentials.apiUrl}/auth/v1/signup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    }),
    'create local Auth user',
  ).arrayBuffer();
  const response = requireOk(
    await fetch(`${credentials.apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    }),
    'authenticate local Auth user',
  );
  const session = await json(response);
  if (
    !isRecord(session) ||
    typeof session.access_token !== 'string' ||
    !isRecord(session.user) ||
    typeof session.user.id !== 'string'
  ) {
    throw new Error('Local Auth returned an invalid session.');
  }
  return { id: session.user.id, accessToken: session.access_token };
}

function authHeaders(apiKey: string, token: string): Record<string, string> {
  return { apikey: apiKey, Authorization: `Bearer ${token}` };
}

function rpc(
  credentials: Credentials,
  token: string,
  name: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${credentials.apiUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      ...authHeaders(
        token === credentials.serviceRoleKey ? credentials.serviceRoleKey : credentials.anonKey,
        token,
      ),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function uploadObject(
  credentials: Credentials,
  token: string,
  objectName: string,
  mediaType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return fetch(storageObjectUrl(credentials.apiUrl, '', objectName), {
    method: 'POST',
    headers: {
      ...authHeaders(
        token === credentials.serviceRoleKey ? credentials.serviceRoleKey : credentials.anonKey,
        token,
      ),
      'Content-Type': mediaType,
    },
    body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

function signObject(
  credentials: Credentials,
  token: string,
  objectName: string,
): Promise<Response> {
  return fetch(storageObjectUrl(credentials.apiUrl, 'sign', objectName), {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 60 }),
  });
}

async function createSignedUrl(
  credentials: Credentials,
  token: string,
  objectName: string,
): Promise<string> {
  const response = requireOk(await signObject(credentials, token, objectName), 'create signed URL');
  const payload = await json(response);
  if (!isRecord(payload) || typeof payload.signedURL !== 'string') {
    throw new Error('Storage returned an invalid signed URL response.');
  }
  return payload.signedURL.startsWith('http')
    ? payload.signedURL
    : `${credentials.apiUrl}/storage/v1${payload.signedURL}`;
}

async function fetchSignedBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Signed Storage fetch failed.');
  }
  return new Uint8Array(await requireOk(response, 'fetch signed object').arrayBuffer());
}

function deleteObject(credentials: Credentials, objectName: string): Promise<Response> {
  return fetch(storageObjectUrl(credentials.apiUrl, '', objectName), {
    method: 'DELETE',
    headers: authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
  });
}

async function expectNativeLimitRejection(
  credentials: Credentials,
  objectName: string,
  mediaType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const upload = await uploadObject(
    credentials,
    credentials.serviceRoleKey,
    objectName,
    mediaType,
    bytes,
  );
  await upload.arrayBuffer();
  const retained = await fetch(storageObjectUrl(credentials.apiUrl, 'authenticated', objectName), {
    headers: authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
  });
  await retained.arrayBuffer();
  expect(upload.ok).toBe(false);
  expect(retained.ok).toBe(false);
}

async function metadataRows(
  credentials: Credentials,
  objectName: string,
): Promise<Record<string, unknown>[]> {
  const response = requireOk(
    await fetch(
      `${credentials.apiUrl}/rest/v1/storage_uploads?select=object_name&object_name=eq.${encodeURIComponent(objectName)}`,
      { headers: authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey) },
    ),
    'read upload metadata',
  );
  return rows(await json(response));
}

function storageObjectUrl(apiUrl: string, operation: string, objectName: string): string {
  const encodedName = objectName.split('/').map(encodeURIComponent).join('/');
  const prefix = operation ? `${operation}/` : '';
  return `${apiUrl}/storage/v1/object/${prefix}${GENERATED_STORAGE_BUCKET}/${encodedName}`;
}

function requireOk(response: Response, operation: string): Response {
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }
  return response;
}

async function expectDenied(response: Response, operation: string): Promise<void> {
  await response.arrayBuffer();
  expect(response.ok, operation).toBe(false);
}

async function json(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('Local Supabase returned invalid JSON.');
  }
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('PostgREST returned an invalid row set.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
