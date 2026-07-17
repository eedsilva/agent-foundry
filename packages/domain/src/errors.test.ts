import { describe, expect, it } from 'vitest';
import { PreviewAccessDeniedError } from './errors.js';

describe('PreviewAccessDeniedError', () => {
  it('carries the session id and reason in a readable message', () => {
    const error = new PreviewAccessDeniedError('sess-1', 'token mismatch');
    expect(error.name).toBe('PreviewAccessDeniedError');
    expect(error.sessionId).toBe('sess-1');
    expect(error.reason).toBe('token mismatch');
    expect(error.message).toContain('sess-1');
    expect(error.message).toContain('token mismatch');
  });
});
