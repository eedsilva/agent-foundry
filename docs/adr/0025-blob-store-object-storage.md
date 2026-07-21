# ADR 0025: BlobStore port and dual filesystem/S3 object storage

- Status: Accepted
- Date: 2026-07-20
- Owners: Persistence and API

## Context

Issue #54 (roadmap key `v08-object-storage`, part of the `v0.8 - Production Data Plane` milestone, under
epic #52) requires artifact bytes to scale past a single local filesystem: a self-hosted deployment
should be able to point at any S3-compatible bucket (AWS S3, MinIO, ...) without changing how artifacts
are created, read, or expired. Its exit criteria require put/get/delete with hash/size/content-type/
encryption metadata, an immutable object key referenced from artifact metadata, downloads via short-lived
signed URL under project authorization, multipart/streaming with no full-buffer, and GC of unreferenced
blobs after a grace period — the required-tests line names large blob, wrong hash, expired URL, and GC.
`FileArtifactStore` previously read and wrote blob bytes directly against
`DATA_DIR`, mixing storage-backend concerns into artifact lifecycle logic and leaving no seam for a second
backend.

## Decision

Introduce a `BlobStore` port (`put`, `getStream`, `stat`, `delete`, `list`, `createSignedDownloadUrl`) in
`packages/domain`, with two adapters in `packages/persistence`: `FsBlobStore` (default) and `S3BlobStore`.
`FileArtifactStore` delegates all blob-byte I/O to whichever adapter the runtime constructs from
`BLOB_STORE_MODE` (`fs` | `s3`, default `fs`); artifact metadata is unchanged.

Object keys are **derived and immutable**: `blobKeyFor(projectId, name, revision)` produces
`projects/<projectId>/artifacts/<name>/<revision:6-digit>`, computed from data already in the metadata
record rather than stored separately. `FsBlobStore` maps artifact-shaped keys onto the exact legacy
on-disk path (`projects/<p>/artifacts/<n>/blobs/<r>.bin`) that `FileArtifactStore` already wrote before
this change, so an existing `DATA_DIR` keeps serving old blobs with zero migration. Non-artifact-shaped
keys (future callers) go under `DATA_DIR/blobs/<encoded-key>`.

Both adapters stream: `FsBlobStore` reuses `atomicWriteStream` (hash + size cap while writing, atomic
rename on success); `S3BlobStore` pipes through a metered `Transform` (`meteredStream`) into
`@aws-sdk/lib-storage`'s `Upload` for multipart streaming, then attaches the computed `sha256` as S3
object metadata via a same-bucket `CopyObjectCommand` (metadata isn't knowable until the stream drains,
but multipart `CreateMultipartUploadCommand` fires on the first chunk). Both fail safe on `stat()` for an
incomplete two-phase write: `FsBlobStore` returns `null` when its `.meta.json` sidecar is missing;
`S3BlobStore` returns `null` when the object has no `sha256` metadata (the exact window between the
`Upload` finishing and the follow-up `Copy` completing). An incomplete write is therefore invisible to
readers and, being unreferenced, naturally eligible for the GC sweep below, instead of appearing as a
valid blob with an empty hash.

Downloads always go through a signed URL scoped to the caller's project authorization
(`GET /projects/:projectId/artifacts/:name/blob-url`, 300s TTL), but the two modes split how that URL is
served, since only one of them needs the API in the download path:

- **`s3` mode**: the URL is a presigned S3 `GetObjectCommand` URL, generated once and handed back
  directly. The API is never in the byte-serving path; expiry and access control are enforced by S3
  itself.
- **`fs` mode**: there is no S3 to presign against, so the API signs its own short-lived token
  (HMAC-SHA256 over `${key}\n${expiresAtMs}`, verified with `timingSafeEqual`) and serves bytes itself
  through `GET /blobs/*?token=...`, registered only when `BLOB_STORE_MODE=fs`.

Unreferenced blobs are removed by `sweepUnreferencedBlobs` (`apps/api/src/blob-gc.ts`), run after
`reapExpired` on the existing artifact-reaper interval: list every key under `projects/`, build the
referenced-key set from every project's artifact metadata (`storage === 'blob' && !blobDeleted`), and
delete keys that are both unreferenced **and** older than `BLOB_GC_GRACE_MS` (default 24h). The grace
window is what makes "revision allocated, bytes uploaded, metadata write still pending or crashed" safe:
the blob stays invisible to readers (nothing references it yet) but isn't swept until it's either finished
or old enough to be recognized as abandoned.

**Supabase** is the intended hosted backend for this project's stack (see `agent-foundry-project-goal` /
Ed's generated-app defaults): Supabase Storage exposes an S3-compatible API at
`https://<project-ref>.storage.supabase.co/storage/v1/s3`, and `supabase start` exposes the same protocol
locally. Because `S3BlobStore` only ever speaks the S3 protocol — endpoint, region, path-style flag, and a
key pair — Supabase needs no dedicated adapter or `supabase-js` dependency; it's just another
`S3_ENDPOINT`/`S3_FORCE_PATH_STYLE=true` combination, exactly like MinIO or AWS S3. One adapter, three
interchangeable backends.

## Alternatives considered

**Reference counting instead of GC-with-grace** was considered and rejected for this iteration.
Refcounting would delete a blob deterministically the instant its last reference drops, with no grace
window and no periodic scan — but it requires a durable counter that's updated transactionally alongside
every metadata write and every `reapExpired`/delete path, which is a bigger, cross-cutting change than this
issue's scope. GC-with-grace only needs a periodic list-and-diff against existing metadata, reusing the
reaper's existing interval and requiring no new persisted state. `ponytail:` the sweep is
O(projects × artifacts) per run with no blob-key index — fine at this project's single-operator scale;
refcounting is the natural upgrade path if sweep cost or GC latency ever shows up in a profile.

**A single unified signed-URL scheme** (e.g., always route through the API, or always require S3) was
rejected because it would either force `fs` mode to depend on infrastructure it doesn't have (no S3 to
presign against) or force `s3` mode to proxy bytes through the API unnecessarily, undermining the
multipart/streaming benefit of using object storage in the first place.

## Migration and rollback

This is additive: `FileArtifactStore`'s public behavior (metadata shape, artifact routes) is unchanged,
and the legacy on-disk blob layout is read as-is by `FsBlobStore` — no backfill, no data conversion.

Rollback to `BLOB_STORE_MODE=fs` is safe at any time: `fs`-written blobs keep working through the legacy
keymap regardless of whether `s3` mode was ever enabled. The only loss is blobs written **while** `s3`
mode was active — those bytes remain in the S3/MinIO bucket (never deleted by a mode switch) but the `fs`
adapter cannot see them, so artifacts created during that window are unreadable until the objects are
copied back into `DATA_DIR` or `s3` mode is re-enabled. Blobs written before or after that window are
unaffected either way.

## Validation

```bash
npx vitest run packages/persistence/src/blob/ apps/api/src/blob-url.test.ts apps/api/src/blob-gc.test.ts
```

`fs-blob-store.test.ts` and `signing.test.ts` cover the port/adapter/HMAC contract in isolation;
`s3-blob-store.test.ts` runs against a real MinIO container (`testcontainers`, skipped without Docker,
throws in CI) covering round-trip with metadata, an 8MB multipart blob, the `maxBytes` and
`expectedSha256` failure paths, `list`/`delete`, and both a fetchable presigned URL and a rejected expired
one; `blob-url.test.ts` and `blob-gc.test.ts` cover the API routes and the grace-period sweep end to end.
