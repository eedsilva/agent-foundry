import { describe, expect, it } from 'vitest';
import {
  BrowserEvidencePolicySchema,
  DEFAULT_BROWSER_EVIDENCE_POLICY,
  ProjectPolicySchema,
  PolicyRecordSchema,
} from './policy.js';

describe('ProjectPolicySchema', () => {
  it('parses a full policy and defaults forbiddenDependencies to []', () => {
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'strict-nextjs',
      version: 3,
      requiredStack: 'nextjs',
      allowedProviders: ['claude', 'codex'],
      allowedCommands: ['typecheck', 'lint', 'test', 'build'],
    });
    expect(policy.forbiddenDependencies).toEqual([]);
    expect(policy.allowedProviders).toEqual(['claude', 'codex']);
  });

  it('rejects the mock provider in allowedProviders', () => {
    expect(() =>
      ProjectPolicySchema.parse({
        schemaVersion: '1',
        id: 'p',
        version: 1,
        allowedProviders: ['mock'],
      }),
    ).toThrow();
  });

  it('rejects a non-positive version and empty allowlists', () => {
    expect(() => ProjectPolicySchema.parse({ schemaVersion: '1', id: 'p', version: 0 })).toThrow();
    expect(() =>
      ProjectPolicySchema.parse({ schemaVersion: '1', id: 'p', version: 1, allowedCommands: [] }),
    ).toThrow();
  });

  it('accepts previewCommands overrides for build and dev script names', () => {
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'custom-scripts',
      version: 1,
      previewCommands: { build: 'compile', dev: 'serve' },
    });
    expect(policy.previewCommands).toEqual({ build: 'compile', dev: 'serve' });
  });

  it('accepts exact HTTP(S) browser origins', () => {
    const policy = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'browser-origins',
      version: 1,
      browserAllowedOrigins: ['https://api.example.test', 'http://127.0.0.1:4100'],
    });

    expect(policy.browserAllowedOrigins).toEqual([
      'https://api.example.test',
      'http://127.0.0.1:4100',
    ]);
  });

  it.each([
    'https://api.example.test/path',
    'https://user:password@api.example.test',
    'https://api.example.test?token=secret',
    'https://api.example.test#fragment',
    'https://*.example.test',
    'ftp://api.example.test',
  ])('rejects non-exact browser origin %s', (browserAllowedOrigin) => {
    expect(
      ProjectPolicySchema.safeParse({
        schemaVersion: '1',
        id: 'browser-origins',
        version: 1,
        browserAllowedOrigins: [browserAllowedOrigin],
      }).success,
    ).toBe(false);
  });
});

describe('PolicyRecordSchema', () => {
  it('requires a sha256 hex hash', () => {
    expect(() => PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'nope' })).toThrow();
    expect(
      PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'a'.repeat(64) }).hash,
    ).toHaveLength(64);
  });
});

describe('BrowserEvidencePolicySchema', () => {
  it('defaults to no trace/video capture', () => {
    expect(DEFAULT_BROWSER_EVIDENCE_POLICY).toEqual({ captureTrace: false, captureVideo: false });
  });

  it('is accepted as an optional field on ProjectPolicySchema', () => {
    const parsed = ProjectPolicySchema.parse({
      schemaVersion: '1',
      id: 'default',
      version: 1,
      browserEvidence: { captureTrace: true, captureVideo: true },
    });
    expect(parsed.browserEvidence).toEqual({ captureTrace: true, captureVideo: true });
  });
});
