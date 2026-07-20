import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '@agent-foundry/domain';

function hmac(secret: string, key: string, expiresAtMs: number): string {
  return createHmac('sha256', secret).update(`${key}\n${expiresAtMs}`).digest('hex');
}

export function signBlobToken(secret: string, key: string, expiresAtMs: number): string {
  return `${expiresAtMs}.${hmac(secret, key, expiresAtMs)}`;
}

export function verifyBlobToken(
  secret: string,
  key: string,
  token: string,
  nowMs: number,
): boolean {
  const separator = token.indexOf('.');
  if (separator === -1) return false;
  const expiresAtMs = Number(token.slice(0, separator));
  if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) return false;

  const actual = Buffer.from(token.slice(separator + 1), 'hex');
  const expected = Buffer.from(hmac(secret, key, expiresAtMs), 'hex');
  return constantTimeEquals(actual, expected);
}
