import { describe, expect, it } from 'vitest';
import { ArtifactTooLargeError, PreviewAccessDeniedError } from './errors.js';

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

describe('ArtifactTooLargeError', () => {
  it('names ArtifactTooLargeError with the byte ceiling in its message', () => {
    const error = new ArtifactTooLargeError(1_024);
    expect(error.name).toBe('ArtifactTooLargeError');
    expect(error.message).toContain('1024');
  });
});
