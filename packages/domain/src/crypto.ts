import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time equality for secrets (tokens, digests): the length check runs
 * first (length isn't secret-dependent) and only then timingSafeEqual, so a
 * mismatch never leaks byte-by-byte comparison timing.
 */
export function constantTimeEquals(a: string | Buffer, b: string | Buffer): boolean {
  const bufferA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufferB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
