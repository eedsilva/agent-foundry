import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { ArtifactTooLargeError } from '@agent-foundry/domain';

export interface MeteredStream {
  /** Pass-through Transform: hashes and counts bytes, errors once maxBytes is exceeded. */
  transform: Transform;
  /** Call only after the transform has finished (e.g. once the sink awaits completion). */
  digest(): { sha256: string; sizeBytes: number };
}

/** Shared streaming hasher/size-cap used by BlobStore implementations that can't hash after the fact (unlike FsBlobStore's temp file). */
export function meteredStream(maxBytes: number): MeteredStream {
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
