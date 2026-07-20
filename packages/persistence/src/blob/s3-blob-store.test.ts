import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { beforeEach, expect, it } from 'vitest';
import { ArtifactTooLargeError, BlobIntegrityError } from '@agent-foundry/domain';
import type { S3BlobStore } from './s3-blob-store.js';
import { describeMinio, MINIO_BUCKET, MINIO_CREDENTIALS } from './s3-testing.js';

function streamOf(content: Buffer): Readable {
  return Readable.from([content]);
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Buffer.equals() does a native memcmp; vitest/chai's generic `toEqual`
 * walks large Buffers element-by-element and turns an 8MB comparison into a
 * ~30s O(n) crawl, so byte-identity checks go through this instead.
 */
function expectBytesEqual(actual: Buffer, expected: Buffer): void {
  expect(actual.equals(expected)).toBe(true);
}

function uniqueKey(label: string): string {
  return `blob-store-tests/${label}/${randomUUID()}`;
}

describeMinio('S3BlobStore (MinIO)', ({ store, endpoint }) => {
  let blobStore: S3BlobStore;

  beforeEach(() => {
    blobStore = store();
  });

  it('round-trips a blob through put, stat, and getStream, including sha256 metadata', async () => {
    const key = uniqueKey('roundtrip');
    const content = Buffer.from('hello minio');
    const expectedSha256 = createHash('sha256').update(content).digest('hex');

    const stat = await blobStore.put(
      { key, contentType: 'text/plain', maxBytes: 1024, expectedSha256 },
      streamOf(content),
    );

    expect(stat.key).toBe(key);
    expect(stat.contentType).toBe('text/plain');
    expect(stat.sizeBytes).toBe(content.byteLength);
    expect(stat.sha256).toBe(expectedSha256);

    // put()'s createdAt comes from CopyObjectResult's LastModified (XML body,
    // sub-second precision); stat()'s comes from HeadObject's Last-Modified
    // (an HTTP date header, always truncated to whole seconds) — so the two
    // legitimately differ by up to ~1s even though both name "now". Assert
    // everything else byte-for-byte and only require createdAt to be a valid
    // timestamp.
    const restated = await blobStore.stat(key);
    expect(restated).toEqual({ ...stat, createdAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(restated!.createdAt))).toBe(false);

    const readBack = await blobStore.getStream(key);
    if (!readBack) throw new Error('expected a stream for a key that was just written');
    expectBytesEqual(await readAll(readBack), content);
  });

  it('stat() returns null for an object written without sha256 metadata (simulated incomplete two-phase put)', async () => {
    const key = uniqueKey('no-metadata');

    // Bypass S3BlobStore.put() entirely: write straight through a raw client to
    // simulate the process dying between the multipart Upload and the follow-up
    // CopyObjectCommand that attaches sha256, so no sha256 metadata is ever set.
    const rawClient = new S3Client({
      endpoint: endpoint(),
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: MINIO_CREDENTIALS,
    });
    try {
      await rawClient.send(
        new PutObjectCommand({
          Bucket: MINIO_BUCKET,
          Key: key,
          Body: Buffer.from('orphaned upload'),
          ContentType: 'text/plain',
        }),
      );
    } finally {
      rawClient.destroy();
    }

    await expect(blobStore.stat(key)).resolves.toBeNull();
  });

  it('streams an 8MB blob (exceeding one 5MB multipart chunk) byte-identically', async () => {
    const key = uniqueKey('large');
    const content = randomBytes(8 * 1024 * 1024);
    const expectedSha256 = createHash('sha256').update(content).digest('hex');

    const stat = await blobStore.put(
      { key, contentType: 'application/octet-stream', maxBytes: content.byteLength },
      streamOf(content),
    );

    expect(stat.sizeBytes).toBe(content.byteLength);
    expect(stat.sha256).toBe(expectedSha256);

    const readBack = await blobStore.getStream(key);
    if (!readBack) throw new Error('expected a stream for a key that was just written');
    expectBytesEqual(await readAll(readBack), content);
  });

  it('aborts and leaves no object behind when maxBytes is exceeded mid-stream', async () => {
    const key = uniqueKey('oversized');
    const content = randomBytes(1024 * 1024);

    await expect(
      blobStore.put(
        { key, contentType: 'application/octet-stream', maxBytes: 1024 },
        streamOf(content),
      ),
    ).rejects.toThrow(ArtifactTooLargeError);

    await expect(blobStore.stat(key)).resolves.toBeNull();
  });

  it('throws BlobIntegrityError and leaves no object behind on a sha256 mismatch', async () => {
    const key = uniqueKey('checked');
    const content = Buffer.from('trust but verify');

    await expect(
      blobStore.put(
        { key, contentType: 'text/plain', maxBytes: 1024, expectedSha256: 'deadbeef' },
        streamOf(content),
      ),
    ).rejects.toThrow(BlobIntegrityError);

    await expect(blobStore.stat(key)).resolves.toBeNull();
  });

  it('list(prefix) returns exactly the keys under the prefix', async () => {
    const root = uniqueKey('listing');
    await blobStore.put(
      { key: `${root}/a`, contentType: 'text/plain', maxBytes: 1024 },
      streamOf(Buffer.from('a')),
    );
    await blobStore.put(
      { key: `${root}/b`, contentType: 'text/plain', maxBytes: 1024 },
      streamOf(Buffer.from('b')),
    );
    await blobStore.put(
      { key: uniqueKey('listing-other'), contentType: 'text/plain', maxBytes: 1024 },
      streamOf(Buffer.from('c')),
    );

    const entries = await blobStore.list(`${root}/`);
    expect(entries.map((entry) => entry.key).sort()).toEqual([`${root}/a`, `${root}/b`]);
    for (const entry of entries) {
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
    }
  });

  it('delete is idempotent', async () => {
    const key = uniqueKey('deletable');
    await blobStore.put(
      { key, contentType: 'text/plain', maxBytes: 1024 },
      streamOf(Buffer.from('bye')),
    );
    await blobStore.delete(key);
    await expect(blobStore.stat(key)).resolves.toBeNull();
    await expect(blobStore.delete(key)).resolves.toBeUndefined();
  });

  it('presigned download URL is fetchable and carries an expiry parameter', async () => {
    const key = uniqueKey('presigned');
    const content = Buffer.from('signed content');
    await blobStore.put({ key, contentType: 'text/plain', maxBytes: 1024 }, streamOf(content));

    const url = await blobStore.createSignedDownloadUrl(key, 60);
    expect(url).toContain('X-Amz-Expires=60');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(content.toString('utf8'));
  });

  it('rejects a fetch against an expired presigned URL with 403 ("URL expirada")', async () => {
    const key = uniqueKey('expiring');
    await blobStore.put(
      { key, contentType: 'text/plain', maxBytes: 1024 },
      streamOf(Buffer.from('will expire')),
    );

    const url = await blobStore.createSignedDownloadUrl(key, 1);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const response = await fetch(url);
    expect(response.status).toBe(403);
  });
});
