import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { buildCreateArgs, SANDBOX_TMP_SIZE_MIB, SANDBOX_WORKSPACE_PATH } from './docker-sandbox-runner.js';

const PINNED_IMAGE =
  'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: PINNED_IMAGE,
    resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256, pids: 64 },
    network: { mode: 'none', allowedHosts: [] },
    mounts: [],
    ttlMs: 60_000,
    user: '1000:1000',
    ...overrides,
  };
}

describe('buildCreateArgs', () => {
  it('builds a hardened docker create invocation', () => {
    const args = buildCreateArgs(spec());
    expect(args).toEqual([
      'create',
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=0.500',
      '--network=none',
      `--tmpfs=${SANDBOX_WORKSPACE_PATH}:rw,nosuid,nodev,size=256m,mode=1777`,
      `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${SANDBOX_TMP_SIZE_MIB}m,mode=1777`,
      PINNED_IMAGE,
      'sleep',
      'infinity',
    ]);
  });

  it('never emits --privileged and always drops all capabilities', () => {
    const args = buildCreateArgs(spec());
    expect(args).not.toContain('--privileged');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('maps network mode allowlist to the bridge network', () => {
    const args = buildCreateArgs(spec({ network: { mode: 'allowlist', allowedHosts: ['example.com'] } }));
    expect(args).toContain('--network=bridge');
  });

  it('appends -v flags for each mount, honoring readOnly', () => {
    const args = buildCreateArgs(
      spec({
        mounts: [
          { source: '/host/cache', target: '/mnt/cache', readOnly: true },
          { source: '/host/scratch', target: '/mnt/scratch', readOnly: false },
        ],
      }),
    );
    expect(args).toContain('-v');
    expect(args).toContain('/host/cache:/mnt/cache:ro');
    expect(args).toContain('/host/scratch:/mnt/scratch');
    expect(args).not.toContain('/host/scratch:/mnt/scratch:ro');
  });

  it('rejects an image that is not pinned by digest', () => {
    expect(() => buildCreateArgs(spec({ image: 'node:22-bookworm-slim' }))).toThrow(
      /pinned by digest/,
    );
  });

  it('rejects a mount referencing the host Docker socket', () => {
    expect(() =>
      buildCreateArgs(
        spec({ mounts: [{ source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false }] }),
      ),
    ).toThrow(/Docker socket/);
  });

  it('rejects a mount targeting the reserved workspace path', () => {
    expect(() =>
      buildCreateArgs(spec({ mounts: [{ source: '/host/x', target: SANDBOX_WORKSPACE_PATH, readOnly: false }] })),
    ).toThrow(/reserved/);
  });

  it('rejects a mount targeting the reserved tmp path', () => {
    expect(() =>
      buildCreateArgs(spec({ mounts: [{ source: '/host/x', target: '/tmp', readOnly: false }] })),
    ).toThrow(/reserved/);
  });
});
