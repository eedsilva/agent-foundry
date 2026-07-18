import { describe, expect, it } from 'vitest';
import { SandboxSnapshotPathSchema, SandboxSpecSchema } from './index.js';

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
    expect(SandboxSpecSchema.safeParse({ ...spec, controlPlane: { token: 'secret' } }).success).toBe(false);
  });
});

describe('SandboxSnapshotPathSchema', () => {
  it.each(['/workspace/.env', '../.env', 'src/../.env'])('rejects unsafe snapshot path %s', (path) => {
    expect(SandboxSnapshotPathSchema.safeParse(path).success).toBe(false);
  });
});
