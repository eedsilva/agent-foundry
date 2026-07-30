import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobListEntry, BlobPutInput, BlobStat, BlobStore } from '@agent-foundry/domain';
import { ArtifactTooLargeError, BlobIntegrityError } from '@agent-foundry/domain';

export interface S3BlobStoreOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

const METADATA_SUFFIX = '.agent-foundry-meta.json';

function isNotFoundError(error: unknown): boolean {
  const meta = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata;
  return meta?.httpStatusCode === 404;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function metadataKey(key: string): string {
  return `${key}${METADATA_SUFFIX}`;
}

function withCleanupFailureCause(error: unknown, cleanupError: AggregateError): unknown {
  if (!(error instanceof Error)) {
    return new AggregateError(
      [normalizeError(error), cleanupError],
      'S3BlobStore put failed and final-object cleanup also failed.',
    );
  }

  const withCause = error as Error & { cause?: unknown };
  if (withCause.cause === undefined) {
    Object.defineProperty(withCause, 'cause', {
      value: cleanupError,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return error;
}

interface MeteredStream {
  /** Pass-through Transform: hashes and counts bytes, errors once maxBytes is exceeded. */
  transform: Transform;
  /** Call only after the transform has finished (e.g. once the sink awaits completion). */
  digest(): { sha256: string; sizeBytes: number };
}

interface BlobMetadata {
  sha256: string;
  createdAt: string;
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
      const integrityError = new BlobIntegrityError(input.key, input.expectedSha256, sha256);
      try {
        await this.delete(input.key);
      } catch (cleanupError) {
        withCleanupFailureCause(
          integrityError,
          new AggregateError(
            [normalizeError(cleanupError)],
            'S3BlobStore final-object cleanup failed.',
          ),
        );
      }
      throw integrityError;
    }

    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: input.key }),
    );
    const createdAt = (head.LastModified ?? new Date()).toISOString();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: metadataKey(input.key),
        Body: JSON.stringify({ sha256, createdAt } satisfies BlobMetadata),
        ContentType: 'application/json',
      }),
    );

    return {
      key: input.key,
      sha256,
      sizeBytes,
      contentType: input.contentType,
      createdAt,
      ...(head.ServerSideEncryption
        ? { encryption: { algorithm: head.ServerSideEncryption } }
        : {}),
    };
  }

  async getStream(key: string): Promise<Readable | null> {
    try {
      if (!(await this.readMetadata(key))) return null;
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
      const metadata = await this.readMetadata(key);
      if (!metadata) return null;
      return {
        key,
        sha256: metadata.sha256,
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? 'application/octet-stream',
        createdAt: metadata.createdAt,
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
    await Promise.all([this.deleteObject(key), this.deleteObject(metadataKey(key))]);
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
        if (!object.Key || object.Key.endsWith(METADATA_SUFFIX)) continue;
        results.push({
          key: object.Key,
          createdAt: (object.LastModified ?? new Date()).toISOString(),
        });
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return results;
  }

  async createSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  private async deleteObject(key: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch((error) => {
        if (!isNotFoundError(error)) throw error;
      });
  }

  private async readMetadata(key: string): Promise<BlobMetadata | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: metadataKey(key) }),
      );
      if (!result.Body) return null;
      const body = result.Body as unknown as AsyncIterable<Uint8Array | string>;
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      let parsed: Partial<BlobMetadata>;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<BlobMetadata>;
      } catch {
        return null;
      }
      if (typeof parsed.sha256 !== 'string' || typeof parsed.createdAt !== 'string') return null;
      return { sha256: parsed.sha256, createdAt: parsed.createdAt };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  }
}
