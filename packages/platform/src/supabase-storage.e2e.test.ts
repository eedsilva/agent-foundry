import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SupabaseGeneratedProjectRuntime } from './supabase-runtime.js';
import { GENERATED_STORAGE_BUCKET, GENERATED_STORAGE_MAX_BYTES } from './supabase-storage.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = 'project-a';
const FETCH_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;

interface Credentials {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
}

interface User {
  id: string;
  accessToken: string;
}

interface SignedUpload {
  url: string;
  token: string;
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
        let bodyError: unknown;

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

          const preparedMetadata = await metadataRows(credentials, objectName, userA.accessToken);
          expect(preparedMetadata).toHaveLength(1);
          expect(preparedMetadata[0]?.object_name).toBe(objectName);
          expect(preparedMetadata[0]?.owner_id).toBe(userA.id);

          const directMetadataName = `${userA.id}/direct-metadata.png`;
          await expectClientError(
            await insertStorageMetadata(credentials, userA, {
              object_name: directMetadataName,
              owner_id: userA.id,
              media_type: 'image/png',
              size_bytes: 1,
              scan_status: 'clean',
              retain_until: new Date(0).toISOString(),
              exported_at: new Date(0).toISOString(),
            }),
            'direct upload metadata insert',
          );
          expect(
            await metadataRows(credentials, directMetadataName, userA.accessToken),
          ).toHaveLength(0);

          const signedUpload = await createSignedUploadUrl(
            credentials,
            userA.accessToken,
            objectName,
          );
          await expectClientError(
            await requestSignedUploadUrl(credentials, userB.accessToken, objectName),
            'cross-owner signed upload URL',
          );
          await requireOk(
            await uploadToSignedUrl(credentials, userA.accessToken, signedUpload, allowedBytes),
            'upload allowed object through signed URL',
          ).arrayBuffer();

          await expectClientError(
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
          await expectClientError(
            await signObject(credentials, userB.accessToken, objectName),
            'cross-owner signed URL',
          );
          await expectClientError(
            await readObject(credentials, userB.accessToken, objectName),
            'cross-owner object fetch',
          );

          const oversizedDeclaration = `${userA.id}/declared-oversized.png`;
          const wrongTypeDeclaration = `${userA.id}/declared-wrong-type.txt`;
          await expectClientError(
            await rpc(credentials, userA.accessToken, 'prepare_storage_upload', {
              p_object_name: oversizedDeclaration,
              p_media_type: 'image/png',
              p_size_bytes: GENERATED_STORAGE_MAX_BYTES + 1,
            }),
            'oversized upload declaration',
            [400],
          );
          await expectClientError(
            await rpc(credentials, userA.accessToken, 'prepare_storage_upload', {
              p_object_name: wrongTypeDeclaration,
              p_media_type: 'text/plain',
              p_size_bytes: 1,
            }),
            'wrong MIME upload declaration',
            [400],
          );
          expect(await metadataRows(credentials, oversizedDeclaration)).toHaveLength(0);
          expect(await metadataRows(credentials, wrongTypeDeclaration)).toHaveLength(0);

          const oversizedObject = `${userA.id}/native-oversized.png`;
          const wrongTypeObject = `${userA.id}/native-wrong-type.txt`;
          const nativeControlObject = `${userA.id}/native-allowed.png`;
          const nativeControlBytes = new TextEncoder().encode(`native-${randomUUID()}`);
          objectNames.add(nativeControlObject);
          objectNames.add(oversizedObject);
          objectNames.add(wrongTypeObject);
          await requireOk(
            await uploadObject(
              credentials,
              credentials.serviceRoleKey,
              nativeControlObject,
              'image/png',
              nativeControlBytes,
            ),
            'upload native policy control',
          ).arrayBuffer();
          const nativeControlRead = requireOk(
            await readObject(credentials, credentials.serviceRoleKey, nativeControlObject),
            'read native policy control',
          );
          expect(new Uint8Array(await nativeControlRead.arrayBuffer())).toEqual(nativeControlBytes);
          await requireOk(
            await deleteObject(credentials, nativeControlObject),
            'delete native policy control',
          ).arrayBuffer();
          await expectClientError(
            await readObject(credentials, credentials.serviceRoleKey, nativeControlObject),
            'deleted native policy control',
          );
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
                await boundedFetch(
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
        } catch (error) {
          bodyError = error;
        }

        const cleanupError = await cleanupStack(dataDir, workdir, credentials, objectNames);
        if (bodyError && cleanupError) {
          throw new AggregateError(
            [bodyError, cleanupError],
            'Storage E2E body and exact-workdir cleanup both failed.',
          );
        }
        if (cleanupError) throw cleanupError;
        if (bodyError) throw bodyError;
      },
      12 * 60 * 1000,
    );
  },
);

async function cleanupStack(
  dataDir: string,
  workdir: string,
  credentials: Credentials | undefined,
  objectNames: ReadonlySet<string>,
): Promise<Error | undefined> {
  if (credentials) {
    await Promise.allSettled(
      [...objectNames].map(async (objectName) => {
        const response = await deleteObject(credentials, objectName);
        await response.arrayBuffer();
      }),
    );
  }

  try {
    await access(workdir);
  } catch (error) {
    if (!isNotFound(error)) {
      return new Error('Storage cleanup could not inspect the workdir; temporary data retained.');
    }
    try {
      await rm(dataDir, { recursive: true, force: true });
      return undefined;
    } catch {
      return new Error('Storage cleanup could not remove unused temporary data.');
    }
  }

  try {
    await execFileAsync('supabase', ['stop', '--workdir', workdir, '--no-backup', '--yes'], {
      encoding: 'utf8',
      timeout: STOP_TIMEOUT_MS,
    });
  } catch {
    return new Error('Supabase exact-workdir stop failed; temporary data retained for recovery.');
  }
  try {
    await rm(dataDir, { recursive: true, force: true });
    return undefined;
  } catch {
    return new Error('Supabase stopped but temporary data removal failed.');
  }
}

async function readCredentials(workdir: string): Promise<Credentials> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'supabase',
      ['status', '--output', 'json', '--workdir', workdir],
      { encoding: 'utf8', timeout: STOP_TIMEOUT_MS },
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
    await boundedFetch(`${credentials.apiUrl}/auth/v1/signup`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, password }),
    }),
    'create local Auth user',
  ).arrayBuffer();
  const response = requireOk(
    await boundedFetch(`${credentials.apiUrl}/auth/v1/token?grant_type=password`, {
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
  return boundedFetch(`${credentials.apiUrl}/rest/v1/rpc/${name}`, {
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

function insertStorageMetadata(
  credentials: Credentials,
  user: User,
  body: Record<string, unknown>,
): Promise<Response> {
  return boundedFetch(`${credentials.apiUrl}/rest/v1/storage_uploads`, {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, user.accessToken),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
}

function requestSignedUploadUrl(
  credentials: Credentials,
  token: string,
  objectName: string,
): Promise<Response> {
  return boundedFetch(storageObjectUrl(credentials.apiUrl, 'upload/sign', objectName), {
    method: 'POST',
    headers: {
      ...authHeaders(credentials.anonKey, token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

async function createSignedUploadUrl(
  credentials: Credentials,
  token: string,
  objectName: string,
): Promise<SignedUpload> {
  const response = requireOk(
    await requestSignedUploadUrl(credentials, token, objectName),
    'create signed upload URL',
  );
  const payload = await json(response);
  if (!isRecord(payload) || typeof payload.url !== 'string') {
    throw new Error('Storage returned an invalid signed upload response.');
  }
  try {
    const url = new URL(`${credentials.apiUrl}/storage/v1${payload.url}`);
    const signedToken = url.searchParams.get('token');
    if (!signedToken) throw new Error();
    return { url: url.toString(), token: signedToken };
  } catch {
    throw new Error('Storage returned an invalid signed upload response.');
  }
}

async function uploadToSignedUrl(
  credentials: Credentials,
  token: string,
  signedUpload: SignedUpload,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  try {
    const url = new URL(signedUpload.url);
    url.searchParams.set('token', signedUpload.token);
    return await boundedFetch(url, {
      method: 'PUT',
      headers: {
        ...authHeaders(credentials.anonKey, token),
        'x-upsert': 'false',
        'cache-control': 'max-age=3600',
        'content-type': 'image/png',
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
  } catch {
    throw new Error('Signed Storage upload failed.');
  }
}

function uploadObject(
  credentials: Credentials,
  token: string,
  objectName: string,
  mediaType: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return boundedFetch(storageObjectUrl(credentials.apiUrl, '', objectName), {
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
  return boundedFetch(storageObjectUrl(credentials.apiUrl, 'sign', objectName), {
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
    response = await boundedFetch(url);
  } catch {
    throw new Error('Signed Storage fetch failed.');
  }
  return new Uint8Array(await requireOk(response, 'fetch signed object').arrayBuffer());
}

function deleteObject(credentials: Credentials, objectName: string): Promise<Response> {
  return boundedFetch(storageObjectUrl(credentials.apiUrl, '', objectName), {
    method: 'DELETE',
    headers: authHeaders(credentials.serviceRoleKey, credentials.serviceRoleKey),
  });
}

function readObject(
  credentials: Credentials,
  token: string,
  objectName: string,
): Promise<Response> {
  return boundedFetch(storageObjectUrl(credentials.apiUrl, 'authenticated', objectName), {
    headers: authHeaders(
      token === credentials.serviceRoleKey ? credentials.serviceRoleKey : credentials.anonKey,
      token,
    ),
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
  await expectClientError(upload, 'native bucket limit');
  await expectClientError(
    await readObject(credentials, credentials.serviceRoleKey, objectName),
    'native rejected object absence',
  );
}

async function metadataRows(
  credentials: Credentials,
  objectName: string,
  token = credentials.serviceRoleKey,
): Promise<Record<string, unknown>[]> {
  const response = requireOk(
    await boundedFetch(
      `${credentials.apiUrl}/rest/v1/storage_uploads?select=object_name,owner_id&object_name=eq.${encodeURIComponent(objectName)}`,
      {
        headers: authHeaders(
          token === credentials.serviceRoleKey ? credentials.serviceRoleKey : credentials.anonKey,
          token,
        ),
      },
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

function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function requireOk(response: Response, operation: string): Response {
  if (!response.ok) {
    void response.body?.cancel();
    throw new Error(`${operation} failed with HTTP ${response.status}.`);
  }
  return response;
}

async function expectClientError(
  response: Response,
  operation: string,
  expectedStatuses?: readonly number[],
): Promise<void> {
  await response.arrayBuffer();
  const clientError = response.status >= 400 && response.status < 500;
  const expected = !expectedStatuses || expectedStatuses.includes(response.status);
  if (!clientError || !expected) {
    const expectation = expectedStatuses
      ? `HTTP ${expectedStatuses.join(' or ')}`
      : 'an HTTP 4xx client error';
    throw new Error(`${operation} expected ${expectation}; received HTTP ${response.status}.`);
  }
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

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
