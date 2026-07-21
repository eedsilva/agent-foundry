import { describe, expect, it } from 'vitest';
import { signBlobToken, verifyBlobToken } from './signing.js';

const secret = 'test-secret';
const key = 'projects/p1/artifacts/report/000001';
const nowMs = 1_700_000_000_000;

describe('signBlobToken / verifyBlobToken', () => {
  it('accepts a token that has not expired', () => {
    const token = signBlobToken(secret, key, nowMs + 60_000);
    expect(verifyBlobToken(secret, key, token, nowMs)).toBe(true);
  });

  it('rejects a token verified against a different key', () => {
    const token = signBlobToken(secret, key, nowMs + 60_000);
    expect(verifyBlobToken(secret, 'projects/p1/artifacts/report/000002', token, nowMs)).toBe(
      false,
    );
  });

  it('rejects a tampered token', () => {
    const token = signBlobToken(secret, key, nowMs + 60_000);
    const [expiresAt, hex] = token.split('.');
    const tamperedHex = hex === undefined ? '' : hex.replace(/^./, hex[0] === '0' ? '1' : '0');
    expect(verifyBlobToken(secret, key, `${expiresAt}.${tamperedHex}`, nowMs)).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = signBlobToken(secret, key, nowMs - 1);
    expect(verifyBlobToken(secret, key, token, nowMs)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifyBlobToken(secret, key, 'not-a-token', nowMs)).toBe(false);
  });
});
