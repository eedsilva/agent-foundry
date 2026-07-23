import { describe, expect, it } from 'vitest';
import {
  FunctionArtifactSchema,
  FunctionInvocationResultSchema,
  FunctionVersionSchema,
} from './index.js';

const ARTIFACT = {
  name: 'send-welcome-email',
  entrypoint: 'index.ts',
  verifyJwt: true,
  envRefs: ['RESEND_API_KEY'],
  timeoutMs: 5_000,
  memoryMb: 128,
  egressAllowlist: ['api.resend.com'],
};

describe('FunctionArtifactSchema', () => {
  it('accepts a well-formed artifact', () => {
    expect(FunctionArtifactSchema.parse(ARTIFACT)).toEqual(ARTIFACT);
  });

  it('rejects an env ref that is not SCREAMING_SNAKE_CASE', () => {
    expect(() =>
      FunctionArtifactSchema.parse({ ...ARTIFACT, envRefs: ['resendApiKey'] }),
    ).toThrow();
  });

  it('rejects a timeout beyond the platform ceiling', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, timeoutMs: 120_000 })).toThrow();
  });

  it('rejects a memory limit beyond the platform ceiling', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, memoryMb: 4096 })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => FunctionArtifactSchema.parse({ ...ARTIFACT, extra: true })).toThrow();
  });
});

describe('FunctionVersionSchema', () => {
  it('accepts a version manifest referencing a valid artifact', () => {
    const version = {
      functionName: ARTIFACT.name,
      versionId: 'b6a0f5f0-2f8e-4b7a-9c1e-2b6f1a0d9e11',
      checksum: 'a'.repeat(64),
      artifact: ARTIFACT,
      createdAt: '2026-07-23T12:00:00.000Z',
    };
    expect(FunctionVersionSchema.parse(version)).toEqual(version);
  });

  it('rejects a non-hex checksum', () => {
    expect(() =>
      FunctionVersionSchema.parse({
        functionName: ARTIFACT.name,
        versionId: 'b6a0f5f0-2f8e-4b7a-9c1e-2b6f1a0d9e11',
        checksum: 'not-a-checksum',
        artifact: ARTIFACT,
        createdAt: '2026-07-23T12:00:00.000Z',
      }),
    ).toThrow();
  });
});

describe('FunctionInvocationResultSchema', () => {
  it('accepts a successful invocation result', () => {
    const result = { status: 200, body: '{"ok":true}', durationMs: 42, timedOut: false };
    expect(FunctionInvocationResultSchema.parse(result)).toEqual(result);
  });

  it('rejects an out-of-range HTTP status', () => {
    expect(() =>
      FunctionInvocationResultSchema.parse({
        status: 999,
        body: '',
        durationMs: 0,
        timedOut: false,
      }),
    ).toThrow();
  });
});
