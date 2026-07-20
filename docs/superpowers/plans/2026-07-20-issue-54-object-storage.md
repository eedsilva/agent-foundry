# Issue #54 — Object storage for large blobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `BlobStore` port with two adapters — filesystem (default, keeps Personal v1 unchanged) and S3-compatible (MinIO/S3, `BLOB_STORE_MODE=s3`) — so screenshots, traces, logs and bundles stop living inside API-served files/rows; artifact blob bytes route through it, downloads get short-lived signed URLs with project authorization, writes stream with integrity hashing, and a GC sweep removes unreferenced objects after a grace period.

**Architecture:** New `BlobStore` port in `packages/domain/src/ports.ts` (put/getStream/stat/delete/list/createSignedDownloadUrl). `FileArtifactStore` delegates blob byte I/O to the injected `BlobStore` under immutable keys `projects/<projectId>/artifacts/<name>/<revision:6>` while keeping metadata exactly where it is today (index.json) — additive refactor, observable behavior of the `ArtifactStore` port unchanged. `FsBlobStore` stores bytes under `DATA_DIR/blobs/<key>` and signs URLs with HMAC (secret from config) verified by a new API route; `S3BlobStore` uses `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (streaming multipart) + `@aws-sdk/s3-request-presigner`. GC: `reapUnreferenced(referencedKeys, graceMs)` driven by the existing artifact reaper sweep in `apps/api`.

**Tech Stack:** `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` (deps of `packages/persistence`); MinIO via `testcontainers` GenericContainer for tests; `node:crypto` HMAC for Fs signing.

## Global Constraints

- Work from `/Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-54-object-storage` on branch `agent/issue-54-object-storage`. **First step of every task: `cd` there and verify `git rev-parse --abbrev-ref HEAD`.** All paths below are relative to this worktree root.
- `packages/persistence` imports only `@agent-foundry/contracts` + `@agent-foundry/domain` internally (architecture check). AWS SDK is external — allowed.
- TypeScript `strict` + `exactOptionalPropertyTypes` (conditional spread for optionals), ESM with `.js` import suffixes.
- File-mode default behavior must be byte-for-byte compatible for existing DATA_DIRs: `FsBlobStore` MUST read/write the EXISTING blob layout `projects/<projectId>/artifacts/<name>/blobs/<revision:6>.bin` when keys have the artifact shape — see Task 2 keymap note. No data migration in this PR.
- The existing `GET /projects/:projectId/artifacts/:name/blob` route keeps working unchanged (streams through the store).
- MinIO-backed tests: skip when Docker unavailable locally, never skip in CI (same `probeDocker` pattern: throw in CI).
- Do not modify `planning/`. Commit per task referencing #54. Full `npm run check` + `npm run e2e --workspace @agent-foundry/api` before PR.

---

### Task 1: `BlobStore` port + `FsBlobStore` adapter (streaming, hashing, HMAC signed URLs)

**Files:**
- Modify: `packages/domain/src/ports.ts` (append port — do not touch existing interfaces)
- Create: `packages/persistence/src/blob/fs-blob-store.ts`
- Create: `packages/persistence/src/blob/signing.ts`
- Modify: `packages/persistence/src/index.ts` (barrel exports)
- Test: `packages/persistence/src/blob/fs-blob-store.test.ts`
- Test: `packages/persistence/src/blob/signing.test.ts`

**Interfaces (Produces — exact, later tasks depend on these):**

```ts
// packages/domain/src/ports.ts (append)
import type { Readable } from 'node:stream';

export interface BlobStat {
  key: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  createdAt: string; // ISO datetime
  encryption?: { algorithm: string };
}

export interface BlobPutInput {
  key: string;
  contentType: string;
  maxBytes: number;
  /** When provided, the store must verify the streamed content hashes to this value and fail otherwise. */
  expectedSha256?: string;
}

export interface SignedUrlOptions {
  expiresInSeconds: number;
  filename?: string;
}

export interface BlobStore {
  put(input: BlobPutInput, source: Readable): Promise<BlobStat>;
  getStream(key: string): Promise<Readable | null>;
  stat(key: string): Promise<BlobStat | null>;
  delete(key: string): Promise<void>;
  /** All keys under a prefix, with creation time — used by GC. */
  list(prefix: string): Promise<Array<{ key: string; createdAt: string }>>;
  createSignedDownloadUrl(key: string, options: SignedUrlOptions): Promise<string>;
}
```

New domain error in `packages/domain/src/errors.ts`: `BlobIntegrityError` (fields `key`, `expectedSha256`, `actualSha256`) following the existing error-class style (check how `ArtifactTooLargeError` is declared and mirror it, including any `code` property).

`signing.ts`:

```ts
export function signBlobToken(secret: string, key: string, expiresAtMs: number): string;
export function verifyBlobToken(secret: string, key: string, token: string, nowMs: number): boolean;
```
HMAC-SHA256 over `${key}\n${expiresAtMs}`, token = `${expiresAtMs}.${hex}`; verify recomputes + `timingSafeEqual` + expiry check.

`FsBlobStore` constructor: `(dataDir: string, options: { signingSecret: string; publicBaseUrl: string })`. `createSignedDownloadUrl` returns `${publicBaseUrl}/blobs/${encodeURIComponent(key)}?token=${signBlobToken(...)}` (route added in Task 4). Storage path: see keymap in Task 2 (artifact-shaped keys map onto the legacy layout; all other keys → `DATA_DIR/blobs/<safe-encoded-key>`). Reuse `atomicWriteStream` from `../fs-utils.js` for streaming+hash+maxBytes; after write, when `expectedSha256` set and mismatched → delete file, throw `BlobIntegrityError`. `stat` persists no sidecar: recompute size from `fs.stat` and store sha256+contentType in a tiny sidecar JSON `<path>.meta.json` written atomically (needed because Fs has no object metadata; GC `list` walks the directory using file mtimes as `createdAt`).

- [ ] **Step 1: failing tests** — full code: roundtrip (put stream → stat → getStream bytes equal, sha256 = known vector for `"hello world"`), maxBytes exceeded throws `ArtifactTooLargeError` and leaves nothing behind, `expectedSha256` mismatch throws `BlobIntegrityError` and leaves nothing behind, missing key → `getStream`/`stat` null, delete idempotent, `list(prefix)` returns exactly the keys under the prefix, signing verify accepts valid + rejects tampered key/expired token (fixed `nowMs`, no real clock).
- [ ] **Step 2: run, expect FAIL** — `npx vitest run packages/persistence/src/blob/`.
- [ ] **Step 3: implement** (port + error + signing + FsBlobStore + barrel).
- [ ] **Step 4: run, expect PASS**; `npm run typecheck`.
- [ ] **Step 5: commit** — `feat(persistence): BlobStore port with filesystem adapter and HMAC signed URLs (#54)`.

---

### Task 2: Route `FileArtifactStore` blob bytes through `BlobStore`

**Files:**
- Modify: `packages/persistence/src/artifact-store.ts`
- Modify: `packages/persistence/src/artifact-store.test.ts` (only to inject the store; existing assertions stay untouched and must keep passing)
- Test additions in the same test file for delegation behavior

**Interfaces:**
- Consumes: `BlobStore`, `FsBlobStore` (Task 1).
- Produces: `FileArtifactStore` constructor gains an injected blob store: `(dataDir: string, blobStore: BlobStore)` (update call sites in `packages/composition/src/runtime.ts` minimally in this task — construct an `FsBlobStore` with config-derived secret/base URL; full config plumbing lands in Task 4). Metadata gains nothing new — object key is DERIVED (`blobKeyFor(projectId, name, revision)` exported helper `projects/<projectId>/artifacts/<name>/<revision:6-digit>`), keeping metadata immutable and this PR migration-free.
- **Keymap note (backward compatibility):** `FsBlobStore` maps artifact-shaped keys `projects/<p>/artifacts/<n>/<r:6>` to the LEGACY path `projects/<p>/artifacts/<n>/blobs/<r:6>.bin` (exact same file the current code writes), so existing DATA_DIRs keep serving old blobs with zero migration. Implement the mapping inside `FsBlobStore`'s path resolution (`keyToPath`), with a unit test asserting the exact legacy path is produced. Non-artifact keys (future callers) go under `DATA_DIR/blobs/`.
- `putBlob` flow becomes: allocate revision under the index lock as today → `blobStore.put({key, contentType, maxBytes}, source)` → metadata records `sha256`/`sizeBytes` from the returned `BlobStat` (semantics identical; `atomicWriteStream` usage moves into FsBlobStore — it's already there from Task 1).
- `getBlobStream` → `blobStore.getStream(blobKeyFor(...))` guarded by the same `blobDeleted` metadata check as today.
- `reapExpired` → metadata flip stays; byte deletion becomes `blobStore.delete(key)`.

Steps: extend tests (delegation + legacy-path compat using a pre-seeded legacy `.bin` file readable through the new path) → FAIL → implement → all existing + new artifact-store tests PASS → `npm run typecheck` → commit `refactor(persistence): FileArtifactStore delegates blob bytes to BlobStore (#54)`.

---

### Task 3: `S3BlobStore` (streaming multipart, presigned URLs, MinIO tests)

**Files:**
- Modify: `packages/persistence/package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner` — latest 3.x)
- Modify: root `package.json` devDeps: `testcontainers` (generic; already transitively present via @testcontainers/postgresql? declare explicitly)
- Create: `packages/persistence/src/blob/s3-blob-store.ts`
- Create: `packages/persistence/src/blob/s3-testing.ts`
- Test: `packages/persistence/src/blob/s3-blob-store.test.ts`

**Interfaces:**
- Consumes: `BlobStore` port, `BlobIntegrityError` (Task 1).
- Produces: `S3BlobStore implements BlobStore`, constructor `(options: { endpoint?: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle?: boolean })`. `put`: wrap source in a hashing/size-counting/maxBytes-enforcing `Transform` (shared helper `meteredStream(maxBytes)` — extract into `packages/persistence/src/blob/metered-stream.ts` if not trivially reusable from fs-utils), pipe through `new Upload({client, params:{Bucket, Key, Body, ContentType, Metadata:{sha256}}})` for multipart streaming; abort the upload + throw on cap/integrity violation; sha256/encryption metadata stored as S3 object metadata (`x-amz-meta-sha256`; `encryption` from `ServerSideEncryption` when the bucket reports it). `stat` = `HeadObjectCommand` (null on 404/NotFound). `createSignedDownloadUrl` = `getSignedUrl(client, new GetObjectCommand({Bucket, Key, ResponseContentDisposition: filename ? attachment : undefined}), {expiresIn})`. `list` = paginated `ListObjectsV2Command`.
- `s3-testing.ts`: `describeMinio(name, fn: (ctx: { store: () => S3BlobStore }) => void)` — GenericContainer `minio/minio:latest`, cmd `server /data`, env MINIO_ROOT_USER/PASSWORD, waits for port 9000, creates bucket `test-bucket` via `CreateBucketCommand`; same Docker skip/CI-throw policy as the Postgres harness in the sibling branch (self-contained copy here — do NOT import across branches).

Tests (full code): roundtrip incl. metadata sha256; large blob (8MB random buffer — exceeds one 5MB multipart chunk) streams and round-trips byte-identical; maxBytes cap aborts (no object left: `stat` null); `expectedSha256` mismatch throws `BlobIntegrityError` and leaves no object; presigned URL fetchable via plain `fetch` (works against the container endpoint) and contains an expiry parameter (`X-Amz-Expires=<n>`); expired-URL rejection: presign with `expiresIn: 1`, wait ~2s, `fetch` → 403 (issue's mandatory "URL expirada" test); `list` prefix filtering; delete idempotent.

Steps: failing tests → implement → PASS → typecheck → commit `feat(persistence): S3-compatible BlobStore with multipart streaming and presigned URLs (#54)`.

---

### Task 4: Config + API wiring — mode switch, signed-URL endpoint, blob GC

**Files:**
- Modify: `packages/composition/src/config.ts` (`BLOB_STORE_MODE: z.enum(['fs','s3']).default('fs')`; `BLOB_SIGNING_SECRET: z.string().min(16).optional()` — default: derive a stable per-installation secret file under DATA_DIR (`blob-signing-secret` written once with 0600, read thereafter) so fs mode works out of the box; `S3_ENDPOINT/S3_REGION/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY/S3_FORCE_PATH_STYLE` optional strings; superRefine: mode s3 requires the five S3 vars)
- Modify: `packages/composition/src/runtime.ts` (construct `FsBlobStore` or `S3BlobStore`; expose `blobStore: BlobStore` on `Runtime`; pass into `FileArtifactStore`)
- Modify: `apps/api/src/app.ts`:
  - New route `GET /projects/:projectId/artifacts/:name/blob-url?revision=<n>` → project must exist (existing NotFound flow), artifact metadata must exist and not be `blobDeleted` → `{ url, expiresAt }` with `expiresInSeconds: 300` (constant `BLOB_URL_TTL_SECONDS = 300`). This is the issue's "Downloads usam URL assinada curta e autorização do projeto": authorization = the same access checks the existing blob route performs (mirror them exactly).
  - New route `GET /blobs/:key(.*)?token=…` (fs mode only — register conditionally when the runtime's blob store is an `FsBlobStore`): verifies `verifyBlobToken`, streams bytes with metadata content-type; 403 invalid/expired; 404 missing. (S3 mode returns direct presigned S3 URLs, so this route is fs-only.)
- Modify: `apps/api/src/artifact-reaper.ts` sweep: after `reapExpired`, run GC: `blobStore.list('projects/')` → keys not present in any artifact metadata (`listMetadata` per project; helper `runtime.projectService`-level or direct store scan) AND `createdAt` older than `BLOB_GC_GRACE_MS` (env, default 86_400_000) → `blobStore.delete`. Extract to `apps/api/src/blob-gc.ts` with signature `sweepUnreferencedBlobs(runtime: { blobStore: BlobStore; artifacts: ArtifactStore; projects: ProjectRepository }, graceMs: number, now: Date): Promise<number>` for testability. The grace period is what makes "allocated revision, bytes uploaded, metadata write pending/crashed" safe.
- Modify: `docker-compose.yml`: add commented-out `minio` service block (image `minio/minio`, `server /data --console-address :9001`, volume `minio_data`) + commented S3_* envs on api/worker; `.env.example`: all new vars with comments.
- Test: `apps/api/src/blob-url.test.ts` (route: happy path fs-mode → returned URL fetchable via `app.inject` on the `/blobs/` route; expired token → 403; blobDeleted → 410/404 matching existing blob-route convention; unknown project → 404)
- Test: `apps/api/src/blob-gc.test.ts` (referenced key survives, unreferenced young key survives, unreferenced old key deleted — drive `createdAt` with injected `now`, no sleeps)

**Interfaces:** Consumes Tasks 1-3. Produces the user-visible feature. Follow existing route/test styles in `apps/api/src` (`app.inject`, temp DATA_DIR fixtures — copy setup from `artifacts.test.ts`).

Steps: failing route+gc tests → implement → PASS → typecheck → commit `feat(api): signed blob download URLs and unreferenced-blob GC (#54)`.

---

### Task 5: Docs + final verification + PR

- [ ] `docs/OPERATIONS.md`: new "Object storage" subsection (modes, envs, MinIO quickstart via compose, GC grace semantics, integrity guarantees, rollback = flip `BLOB_STORE_MODE=fs`; existing fs blobs keep working because of the legacy keymap — no migration needed; s3→fs rollback loses only blobs written while in s3 mode).
- [ ] Create `docs/adr/00XX-blob-store-object-storage.md` (next free number; decision: port + dual adapter, HMAC vs presigned split, derived immutable keys, GC-with-grace instead of transactional refcounting — `ponytail:` note that refcounting is the upgrade if grace-period GC ever proves insufficient).
- [ ] Full `npm run check` green; `npm run e2e --workspace @agent-foundry/api` green (fs mode default — proves no regression).
- [ ] Evidence capture: MinIO suite output (large blob, bad hash, expired URL, GC), check tail, e2e summary.
- [ ] Push, open PR `feat: object storage BlobStore with signed URLs and GC (#54)` — body maps the 5 acceptance criteria + 4 mandatory tests to code/test lines, includes evidence, DoD security/migration/rollback assessment, `Closes #54`, standard attribution.

## Self-Review Notes

- "BlobStore suporta put/get/delete, hash, size, content type e encryption metadata" → Task 1 port (+S3 metadata/SSE in Task 3).
- "Artifact metadata referencia object key imutável" → derived `blobKeyFor` (Task 2) — key is a pure function of immutable metadata fields, hence immutable; no metadata schema change needed.
- "Downloads usam URL assinada curta e autorização do projeto" → Task 4 blob-url route (300s TTL) + fs token route/S3 presign.
- "Multipart e streaming evitam buffer completo" → Task 3 `Upload` multipart + metered Transform; Task 1 fs streaming via `atomicWriteStream`.
- "Garbage collector remove blobs não referenciados após grace period" → Task 4 `sweepUnreferencedBlobs`.
- Mandatory tests "Blob grande, hash incorreto, URL expirada e GC" → Task 3 (8MB, hash mismatch, expired presign) + Task 1 (hash mismatch fs) + Task 4 (GC, expired HMAC token).
- Non-goals honored: no Kubernetes, no multi-region, no data migration (legacy keymap instead), file mode stays default.
