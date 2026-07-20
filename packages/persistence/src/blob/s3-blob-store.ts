import type { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobPutInput, BlobStat, BlobStore, SignedUrlOptions } from '@agent-foundry/domain';
import { BlobIntegrityError } from '@agent-foundry/domain';
import { meteredStream } from './metered-stream.js';

export interface S3BlobStoreOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

/** Percent-encodes each key segment while preserving '/' as the path separator, per CopySource's requirements. */
function encodeKeySegments(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function isNotFoundError(error: unknown): boolean {
  const meta = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata;
  return meta?.httpStatusCode === 404;
}

export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async put(input: BlobPutInput, source: Readable): Promise<BlobStat> {
    const { transform, digest } = meteredStream(input.maxBytes);
    // .pipe() doesn't forward source errors to the destination; without this
    // a broken upstream read would leave Upload waiting forever instead of
    // failing (and being aborted) like a maxBytes/integrity violation does.
    source.on('error', (error) => transform.destroy(error));
    const body = source.pipe(transform);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: input.key,
        Body: body,
        ContentType: input.contentType,
      },
    });

    try {
      await upload.done();
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }

    const { sha256, sizeBytes } = digest();

    if (input.expectedSha256 && input.expectedSha256 !== sha256) {
      await this.client
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: input.key }))
        .catch(() => undefined);
      throw new BlobIntegrityError(input.key, input.expectedSha256, sha256);
    }

    // sha256 is only known once the stream has fully drained, so it can't be
    // set at upload time; a same-bucket copy rewrites the object's metadata
    // without re-streaming the (already uploaded) bytes.
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        CopySource: `${this.bucket}/${encodeKeySegments(input.key)}`,
        ContentType: input.contentType,
        Metadata: { sha256 },
        MetadataDirective: 'REPLACE',
      }),
    );

    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: input.key }),
    );

    return {
      key: input.key,
      sha256,
      sizeBytes,
      contentType: input.contentType,
      createdAt: (head.LastModified ?? new Date()).toISOString(),
      ...(head.ServerSideEncryption
        ? { encryption: { algorithm: head.ServerSideEncryption } }
        : {}),
    };
  }

  async getStream(key: string): Promise<Readable | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return result.Body as Readable;
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async stat(key: string): Promise<BlobStat | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        sha256: head.Metadata?.sha256 ?? '',
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? 'application/octet-stream',
        createdAt: (head.LastModified ?? new Date()).toISOString(),
        ...(head.ServerSideEncryption
          ? { encryption: { algorithm: head.ServerSideEncryption } }
          : {}),
      };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<Array<{ key: string; createdAt: string }>> {
    const results: Array<{ key: string; createdAt: string }> = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        results.push({
          key: object.Key,
          createdAt: (object.LastModified ?? new Date()).toISOString(),
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return results;
  }

  async createSignedDownloadUrl(key: string, options: SignedUrlOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: options.filename
        ? `attachment; filename="${options.filename}"`
        : undefined,
    });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
  }
}
