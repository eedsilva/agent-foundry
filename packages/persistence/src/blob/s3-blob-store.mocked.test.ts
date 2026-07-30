import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3BlobStore } from './s3-blob-store.js';

const mockedAws = vi.hoisted(() => ({
  sendMock: vi.fn(),
  uploadAbortMock: vi.fn(),
  uploadDoneMock: vi.fn(),
  uploadParams: undefined as
    | {
        Bucket: string;
        Key: string;
        Body: AsyncIterable<Buffer>;
        ContentType: string;
      }
    | undefined,
}));

vi.mock('@aws-sdk/client-s3', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3')>('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: class {
      send = mockedAws.sendMock;
    },
  };
});

vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: class {
    constructor(options: {
      params: {
        Bucket: string;
        Key: string;
        Body: AsyncIterable<Buffer>;
        ContentType: string;
      };
    }) {
      mockedAws.uploadParams = options.params;
    }

    done = mockedAws.uploadDoneMock;
    abort = mockedAws.uploadAbortMock;
  },
}));

function streamOf(content: Buffer): Readable {
  return Readable.from([content]);
}

async function drainUploadBody(): Promise<void> {
  const body = mockedAws.uploadParams?.Body;
  if (!body) throw new Error('expected mocked upload body');
  for await (const _chunk of body) {
    // Drain the metered stream so put() can finalize its digest.
  }
}

describe('S3BlobStore mocked metadata sidecar finalization', () => {
  beforeEach(() => {
    mockedAws.sendMock.mockReset();
    mockedAws.uploadAbortMock.mockReset();
    mockedAws.uploadDoneMock.mockReset();
    mockedAws.uploadParams = undefined;
  });

  it('uploads bytes directly and persists the sha256 sidecar without CopyObject', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 32,
          ContentType: 'application/octet-stream',
          LastModified: new Date('2026-07-30T12:34:56.000Z'),
          ServerSideEncryption: 'AES256',
        };
      }
      if (command instanceof PutObjectCommand) return {};
      throw new Error(
        `unexpected command ${String((command as { constructor?: { name?: string } }).constructor?.name)}`,
      );
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });
    const content = Buffer.from('supabase-friendly-object-copy');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const stat = await store.put(
      { key: 'artifacts/final.bin', contentType: 'application/octet-stream', maxBytes: 4096 },
      streamOf(content),
    );

    expect(mockedAws.uploadParams?.Key).toBe('artifacts/final.bin');
    expect(mockedAws.uploadParams).toMatchObject({
      Bucket: 'blob-bucket',
      ContentType: 'application/octet-stream',
    });

    expect(mockedAws.sendMock).toHaveBeenCalledTimes(2);
    const headCommand = mockedAws.sendMock.mock.calls[0]![0] as HeadObjectCommand;
    const metadataCommand = mockedAws.sendMock.mock.calls[1]![0] as PutObjectCommand;
    expect(headCommand).toBeInstanceOf(HeadObjectCommand);
    expect(headCommand.input).toMatchObject({
      Bucket: 'blob-bucket',
      Key: 'artifacts/final.bin',
    });
    expect(metadataCommand).toBeInstanceOf(PutObjectCommand);
    expect(metadataCommand.input).toMatchObject({
      Bucket: 'blob-bucket',
      Key: 'artifacts/final.bin.agent-foundry-meta.json',
      ContentType: 'application/json',
    });
    expect(JSON.parse(String(metadataCommand.input.Body))).toEqual({
      sha256,
      createdAt: '2026-07-30T12:34:56.000Z',
    });

    expect(metadataCommand.input).not.toMatchObject({
      Bucket: 'blob-bucket',
      Key: 'artifacts/final.bin',
    });

    expect(stat).toEqual({
      key: 'artifacts/final.bin',
      sha256,
      sizeBytes: content.byteLength,
      contentType: 'application/octet-stream',
      createdAt: '2026-07-30T12:34:56.000Z',
      encryption: { algorithm: 'AES256' },
    });
  });

  it('preserves BlobIntegrityError semantics when final-object cleanup fails', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) {
        throw new Error('final delete failed');
      }
      throw new Error('unexpected command');
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    await expect(
      store.put(
        {
          key: 'artifacts/final.bin',
          contentType: 'application/octet-stream',
          maxBytes: 4096,
          expectedSha256: 'deadbeef',
        },
        streamOf(Buffer.from('cleanup must stay visible')),
      ),
    ).rejects.toMatchObject({
      name: 'BlobIntegrityError',
      cause: expect.any(AggregateError),
    });
  });

  it('leaves a metadata-less object invisible when metadata persistence fails', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: 12,
          ContentType: 'application/octet-stream',
          LastModified: new Date('2026-07-30T12:34:56.000Z'),
        };
      }
      if (command instanceof PutObjectCommand) {
        throw new Error('metadata persistence failed');
      }
      throw new Error('unexpected command');
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    await expect(
      store.put(
        { key: 'artifacts/final.bin', contentType: 'application/octet-stream', maxBytes: 4096 },
        streamOf(Buffer.from('metadata body')),
      ),
    ).rejects.toThrow('metadata persistence failed');
  });

  it('treats malformed metadata sidecars as incomplete blobs', async () => {
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 12 };
      if (command instanceof GetObjectCommand) return { Body: Readable.from(['not json']) };
      throw new Error('unexpected command');
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    await expect(store.stat('artifacts/final.bin')).resolves.toBeNull();
    await expect(store.getStream('artifacts/final.bin')).resolves.toBeNull();
  });

  it('reads legacy object metadata while an S3 sidecar is absent', async () => {
    const content = Buffer.from('legacy object');
    const sha256 = createHash('sha256').update(content).digest('hex');
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      const key = (command as { input?: { Key?: string } }).input?.Key;
      if (command instanceof HeadObjectCommand && key === 'artifacts/legacy.bin') {
        return {
          ContentLength: content.byteLength,
          ContentType: 'text/plain',
          LastModified: new Date('2026-07-30T12:34:56.000Z'),
          Metadata: { sha256 },
        };
      }
      if (command instanceof GetObjectCommand && key?.endsWith('.agent-foundry-meta.json')) {
        throw { $metadata: { httpStatusCode: 404 } };
      }
      if (command instanceof GetObjectCommand && key === 'artifacts/legacy.bin') {
        return { Body: Readable.from([content]) };
      }
      throw new Error(`unexpected command ${String(key)}`);
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    await expect(store.stat('artifacts/legacy.bin')).resolves.toMatchObject({
      key: 'artifacts/legacy.bin',
      sha256,
      contentType: 'text/plain',
      createdAt: '2026-07-30T12:34:56.000Z',
    });
    const stream = await store.getStream('artifacts/legacy.bin');
    await expect(stream?.toArray()).resolves.toEqual([content]);
  });
});
