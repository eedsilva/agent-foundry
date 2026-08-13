import { describe, expect, it } from 'vitest';
import {
  ArtifactTooLargeError,
  MigrationApprovalRequiredError,
  PreviewAccessDeniedError,
} from './errors.js';

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

describe('MigrationApprovalRequiredError', () => {
  it('carries the destructive previews that triggered it', () => {
    const destructive = [
      {
        migrationPath: 'supabase/migrations/0001_drop.sql',
        checksum: 'a'.repeat(64),
        destructiveStatements: ['DROP TABLE tasks'],
      },
    ];
    const error = new MigrationApprovalRequiredError(destructive);
    expect(error.name).toBe('MigrationApprovalRequiredError');
    expect(error.destructive).toBe(destructive);
    expect(error.message).toMatch(/approval and verified backup/);
  });
});
