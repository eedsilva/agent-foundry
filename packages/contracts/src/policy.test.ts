import { describe, expect, it } from 'vitest';
import { ProjectPolicySchema, PolicyRecordSchema } from './policy.js';

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
});

describe('PolicyRecordSchema', () => {
  it('requires a sha256 hex hash', () => {
    expect(() => PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'nope' })).toThrow();
    expect(
      PolicyRecordSchema.parse({ id: 'p', version: 1, hash: 'a'.repeat(64) }).hash,
    ).toHaveLength(64);
  });
});
