import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactTooLargeError, BlobIntegrityError } from '@agent-foundry/domain';
import { FsBlobStore, keyToPath } from './fs-blob-store.js';

function streamOf(content: string): Readable {
  return Readable.from([Buffer.from(content)]);
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('FsBlobStore', () => {
  let dataDir: string;
  let store: FsBlobStore;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'blob-store-'));
    store = new FsBlobStore(dataDir, {
      signingSecret: 'test-secret',
      publicBaseUrl: 'https://example.test',
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('round-trips a blob through put, stat, and getStream', async () => {
    const key = 'projects/p1/artifacts/report/000001';
    const stat = await store.put(
      { key, contentType: 'text/plain', maxBytes: 1024 },
      streamOf('hello world'),
    );

    expect(stat.key).toBe(key);
    expect(stat.contentType).toBe('text/plain');
    expect(stat.sizeBytes).toBe(11);
    expect(stat.sha256).toBe(createHash('sha256').update('hello world').digest('hex'));

    await expect(store.stat(key)).resolves.toEqual(stat);

    const readBack = await store.getStream(key);
    if (!readBack) throw new Error('expected a stream for a key that was just written');
    await expect(readAll(readBack)).resolves.toBe('hello world');
  });

  it('maps artifact-shaped keys onto the legacy on-disk layout', () => {
    const path = keyToPath(dataDir, 'projects/p1/artifacts/report/000001');
    expect(path).toBe(
      join(dataDir, 'projects', 'p1', 'artifacts', 'report', 'blobs', '000001.bin'),
    );
  });

  it('rejects non-artifact-shaped keys', () => {
    expect(() => keyToPath(dataDir, 'misc/some-key')).toThrow(/artifact-shaped/);
  });

  it('throws ArtifactTooLargeError and leaves nothing behind when maxBytes is exceeded', async () => {
    const key = 'projects/p1/artifacts/oversized/000001';
    await expect(
      store.put({ key, contentType: 'text/plain', maxBytes: 4 }, streamOf('hello world')),
    ).rejects.toThrow(ArtifactTooLargeError);

    await expect(store.stat(key)).resolves.toBeNull();
    await expect(store.getStream(key)).resolves.toBeNull();
  });

  it('throws BlobIntegrityError and leaves nothing behind on a sha256 mismatch', async () => {
    const key = 'projects/p1/artifacts/checked/000001';
    await expect(
      store.put(
        { key, contentType: 'text/plain', maxBytes: 1024, expectedSha256: 'deadbeef' },
        streamOf('hello world'),
      ),
    ).rejects.toThrow(BlobIntegrityError);

    await expect(store.stat(key)).resolves.toBeNull();
    await expect(store.getStream(key)).resolves.toBeNull();
  });

  it('returns null from getStream and stat for a missing key', async () => {
    const key = 'projects/p1/artifacts/missing/000001';
    await expect(store.getStream(key)).resolves.toBeNull();
    await expect(store.stat(key)).resolves.toBeNull();
  });

  it('delete is idempotent', async () => {
    const key = 'projects/p1/artifacts/deletable/000001';
    await store.put({ key, contentType: 'text/plain', maxBytes: 1024 }, streamOf('bye'));
    await store.delete(key);
    await expect(store.stat(key)).resolves.toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('list(prefix) returns exactly the keys under the prefix', async () => {
    await store.put(
      { key: 'projects/p1/artifacts/report/000001', contentType: 'text/plain', maxBytes: 1024 },
      streamOf('a'),
    );
    await store.put(
      { key: 'projects/p1/artifacts/report/000002', contentType: 'text/plain', maxBytes: 1024 },
      streamOf('b'),
    );
    await store.put(
      { key: 'projects/p2/artifacts/other/000001', contentType: 'text/plain', maxBytes: 1024 },
      streamOf('c'),
    );

    const entries = await store.list('projects/p1/artifacts/report/');
    expect(entries.map((entry) => entry.key).sort()).toEqual([
      'projects/p1/artifacts/report/000001',
      'projects/p1/artifacts/report/000002',
    ]);
    for (const entry of entries) {
      expect(typeof entry.createdAt).toBe('string');
      expect(Number.isNaN(Date.parse(entry.createdAt))).toBe(false);
    }
  });

  it('createSignedDownloadUrl embeds a verifiable HMAC token', async () => {
    const key = 'projects/p1/artifacts/report/000001';
    const url = await store.createSignedDownloadUrl(key, { expiresInSeconds: 60 });
    expect(url.startsWith(`https://example.test/blobs/${encodeURIComponent(key)}?token=`)).toBe(
      true,
    );
  });
});
