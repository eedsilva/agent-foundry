import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
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
import type {
  BlobListEntry,
  BlobPutInput,
  BlobStat,
  BlobStore,
  SignedUrlOptions,
} from '@agent-foundry/domain';
import { ArtifactTooLargeError, BlobIntegrityError } from '@agent-foundry/domain';

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

interface MeteredStream {
  /** Pass-through Transform: hashes and counts bytes, errors once maxBytes is exceeded. */
  transform: Transform;
  /** Call only after the transform has finished (e.g. once the sink awaits completion). */
  digest(): { sha256: string; sizeBytes: number };
}

/**
 * Hashes and size-caps a stream as it uploads to S3. Only caller is put();
 * FsBlobStore doesn't need this since it hashes from a completed temp file instead.
 */
function meteredStream(maxBytes: number): MeteredStream {
  const hash = createHash('sha256');
  let sizeBytes = 0;

  const transform = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      sizeBytes += buffer.byteLength;
      if (sizeBytes > maxBytes) {
        callback(new ArtifactTooLargeError(maxBytes));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    },
  });

  return {
    transform,
    digest: () => ({ sha256: hash.digest('hex'), sizeBytes }),
  };
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
      // Best-effort delete: if this fails, the corrupt object may persist (still
      // metadata-less, so stat() treats it as incomplete/GC'able), but the
      // BlobIntegrityError below still fires either way.
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
      // put() finalizes in two phases (multipart Upload, then a CopyObjectCommand that
      // attaches sha256); a process death or Copy failure between them leaves an object
      // with no sha256 metadata. Treat that as an incomplete write, not a valid blob, so
      // it stays invisible to readers and eligible for GC as unreferenced.
      if (!head.Metadata?.sha256) return null;
      return {
        key,
        sha256: head.Metadata.sha256,
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

  async list(prefix: string): Promise<BlobListEntry[]> {
    const results: BlobListEntry[] = [];
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
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: options.expiresInSeconds });
  }
}
