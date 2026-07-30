import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { BlobIntegrityError } from '@agent-foundry/domain';
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

describe('S3BlobStore mocked temp-object finalization', () => {
  beforeEach(() => {
    mockedAws.sendMock.mockReset();
    mockedAws.uploadAbortMock.mockReset();
    mockedAws.uploadDoneMock.mockReset();
    mockedAws.uploadParams = undefined;
  });

  it('uploads to a temporary key, copies into the requested final key with sha256 metadata, then deletes the temp object', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        return {
          CopyObjectResult: { LastModified: new Date('2026-07-30T12:34:56.000Z') },
          ServerSideEncryption: 'AES256',
        };
      }
      if (command instanceof DeleteObjectCommand) return {};
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

    const tempKey = mockedAws.uploadParams?.Key;
    expect(tempKey).toBeTruthy();
    expect(tempKey).not.toBe('artifacts/final.bin');
    expect(mockedAws.uploadParams).toMatchObject({
      Bucket: 'blob-bucket',
      ContentType: 'application/octet-stream',
    });

    expect(mockedAws.sendMock).toHaveBeenCalledTimes(2);
    const copyCommand = mockedAws.sendMock.mock.calls[0]![0] as CopyObjectCommand;
    const deleteCommand = mockedAws.sendMock.mock.calls[1]![0] as DeleteObjectCommand;
    expect(copyCommand).toBeInstanceOf(CopyObjectCommand);
    expect(copyCommand.input).toMatchObject({
      Bucket: 'blob-bucket',
      Key: 'artifacts/final.bin',
      ContentType: 'application/octet-stream',
      Metadata: { sha256 },
      MetadataDirective: 'REPLACE',
      CopySource: `blob-bucket/${tempKey!.split('/').map(encodeURIComponent).join('/')}`,
    });
    expect(deleteCommand).toBeInstanceOf(DeleteObjectCommand);
    expect(deleteCommand.input).toMatchObject({
      Bucket: 'blob-bucket',
      Key: tempKey,
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

  it('fails visibly when temporary-object cleanup fails after a successful copy', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof CopyObjectCommand) {
        return { CopyObjectResult: { LastModified: new Date('2026-07-30T12:34:56.000Z') } };
      }
      if (command instanceof DeleteObjectCommand) {
        throw new Error('temp delete failed');
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
        streamOf(Buffer.from('cleanup must stay visible')),
      ),
    ).rejects.toThrow(/temporary-object cleanup failed/i);
  });

  it('preserves BlobIntegrityError semantics while attaching temporary-object cleanup failure details as cause', async () => {
    mockedAws.uploadDoneMock.mockImplementationOnce(drainUploadBody);
    mockedAws.sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteObjectCommand) {
        throw new Error('temp delete failed');
      }
      throw new Error('unexpected command');
    });

    const store = new S3BlobStore({
      bucket: 'blob-bucket',
      region: 'us-east-1',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
    });

    let thrown: unknown;
    try {
      await store.put(
        {
          key: 'artifacts/final.bin',
          contentType: 'application/octet-stream',
          maxBytes: 4096,
          expectedSha256: 'deadbeef',
        },
        streamOf(Buffer.from('hash mismatch')),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BlobIntegrityError);
    expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
    expect(
      ((thrown as Error & { cause?: AggregateError }).cause?.errors ?? []).map((error) =>
        error instanceof Error ? error.message : String(error),
      ),
    ).toContain('temp delete failed');
  });
});
