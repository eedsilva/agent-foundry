import { describe, expect, it } from 'vitest';
import { SandboxExecSchema, SandboxSnapshotPathSchema, SandboxSpecSchema } from './index.js';

const spec = {
  image: 'ghcr.io/agent-foundry/sandbox@sha256:abc',
  resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 1024, pids: 64 },
  network: { mode: 'none', allowedHosts: [] },
  mounts: [{ source: 'workspace', target: '/workspace', readOnly: false }],
  ttlMs: 60_000,
  user: '1000:1000',
};

describe('SandboxSpecSchema', () => {
  it('parses the complete sandbox boundary', () => {
    expect(SandboxSpecSchema.parse(spec)).toMatchObject({ image: spec.image, user: spec.user });
  });

  it('rejects a control-plane field instead of carrying it into the sandbox', () => {
    expect(
      SandboxSpecSchema.safeParse({ ...spec, controlPlane: { token: 'secret' } }).success,
    ).toBe(false);
  });
});

describe('SandboxSnapshotPathSchema', () => {
  it.each(['/workspace/.env', '../.env', 'src/../.env'])(
    'rejects unsafe snapshot path %s',
    (path) => {
      expect(SandboxSnapshotPathSchema.safeParse(path).success).toBe(false);
    },
  );
});

describe('SandboxExecSchema', () => {
  it('accepts an explicit absolute in-container working directory', () => {
    expect(
      SandboxExecSchema.parse({ command: 'npm', args: ['ci'], timeoutMs: 60_000, cwd: '/project' })
        .cwd,
    ).toBe('/project');
  });

  it.each(['project', '/project/../etc', '/project//nested'])('rejects unsafe cwd %s', (cwd) => {
    expect(
      SandboxExecSchema.safeParse({ command: 'npm', args: ['ci'], timeoutMs: 60_000, cwd }).success,
    ).toBe(false);
  });
});
