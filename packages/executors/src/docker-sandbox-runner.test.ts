import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import {
  buildCreateArgs,
  buildNetworkEvidenceArgs,
  buildPolicyNetworkCreateArgs,
  buildPolicySidecarCreateArgs,
  parseNetworkPolicyEvents,
  POLICY_SIDECAR_READY_PATH,
  POLICY_PROXY_PORT,
  SANDBOX_TMP_SIZE_MIB,
  SANDBOX_WORKSPACE_PATH,
} from './docker-sandbox-runner.js';

const PINNED_IMAGE = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: PINNED_IMAGE,
    resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256, pids: 64 },
    network: { mode: 'none', allowedHosts: [], purpose: 'execution' },
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
      '60',
    ]);
  });

  it('bounds the keep-alive sleep to the spec TTL, rounded up to whole seconds', () => {
    const args = buildCreateArgs(spec({ ttlMs: 1_500 }));
    expect(args.slice(-2)).toEqual(['sleep', '2']);
  });

  it('never emits --privileged and always drops all capabilities', () => {
    const args = buildCreateArgs(spec());
    expect(args).not.toContain('--privileged');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('fails closed when allowlist mode has no internal policy-network attachment', () => {
    expect(() =>
      buildCreateArgs(
        spec({
          network: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
        }),
      ),
    ).toThrow(/policy network attachment/);
  });

  it('attaches an allowlisted sandbox only to the internal network and configured sidecar', () => {
    const args = buildCreateArgs(
      spec({
        network: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
      }),
      { networkName: 'af-policy-1', proxyIp: '172.30.0.2' },
    );

    expect(args).toContain('--network=af-policy-1');
    expect(args).not.toContain('--network=bridge');
    expect(args).toContain('--dns=172.30.0.2');
    expect(args).toContain(`HTTP_PROXY=http://172.30.0.2:${POLICY_PROXY_PORT}`);
    expect(args).toContain(`HTTPS_PROXY=http://172.30.0.2:${POLICY_PROXY_PORT}`);
    expect(args).toContain('NO_PROXY=');
  });

  it('hardens the only dual-homed policy sidecar and mounts its compiled entry read-only', () => {
    const args = buildPolicySidecarCreateArgs({
      image: PINNED_IMAGE,
      scriptPath: '/repo/dist/docker-network-policy-sidecar.js',
      encodedPolicy: 'encoded-policy',
      ttlMs: 60_000,
    });

    expect(args).toContain('--network=bridge');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
    expect(args).toContain(
      '/repo/dist/docker-network-policy-sidecar.js:/opt/agent-foundry/network-policy.js:ro',
    );
    expect(args).toContain('AGENT_FOUNDRY_NETWORK_POLICY=encoded-policy');
    expect(args).toContain('AGENT_FOUNDRY_POLICY_TTL_MS=60000');
    expect(POLICY_SIDECAR_READY_PATH).toMatch(/^\/run\//);
    expect(args).toContain('--tmpfs=/run:rw,nosuid,nodev,noexec,size=64k,mode=1777');
    expect(args).toContain('--rm');
    expect(args).not.toContain('--privileged');
  });

  it('labels internal policy networks for crash-recovery cleanup', () => {
    const args = buildPolicyNetworkCreateArgs({
      networkName: 'af-policy-1',
      expiresAt: 1_784_761_200_000,
    });

    expect(args).toEqual([
      'network',
      'create',
      '--internal',
      '--label',
      'agent-foundry.policy=true',
      '--label',
      'agent-foundry.expires-at=1784761200000',
      'af-policy-1',
    ]);
  });

  it('bounds policy log retrieval and event ingestion', () => {
    expect(buildNetworkEvidenceArgs('sidecar-1')).toEqual(['logs', '--tail', '1000', 'sidecar-1']);
    const line = JSON.stringify({
      timestamp: '2026-07-22T12:00:00.000Z',
      purpose: 'execution',
      protocol: 'dns',
      decision: 'deny',
      hostname: 'blocked.example',
      port: 53,
      addresses: [],
      reason: 'not allowlisted',
    });
    expect(
      parseNetworkPolicyEvents(Array.from({ length: 1_005 }, () => line).join('\n')),
    ).toHaveLength(1_000);
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
        spec({
          mounts: [
            { source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false },
          ],
        }),
      ),
    ).toThrow(/Docker socket/);
  });

  it('rejects a mount targeting the reserved workspace path', () => {
    expect(() =>
      buildCreateArgs(
        spec({ mounts: [{ source: '/host/x', target: SANDBOX_WORKSPACE_PATH, readOnly: false }] }),
      ),
    ).toThrow(/reserved/);
  });

  it('rejects a mount targeting the reserved tmp path', () => {
    expect(() =>
      buildCreateArgs(spec({ mounts: [{ source: '/host/x', target: '/tmp', readOnly: false }] })),
    ).toThrow(/reserved/);
  });

  it.each(['/', '/var/run', '/run', '/proc', '/sys', '/dev', '/etc'])(
    'rejects a mount sourced from the sensitive root %s even without "docker.sock" in the path',
    (root) => {
      expect(() =>
        buildCreateArgs(spec({ mounts: [{ source: root, target: '/mnt/x', readOnly: true }] })),
      ).toThrow(/too broad/);
    },
  );

  it('rejects a mount targeting a sensitive root', () => {
    expect(() =>
      buildCreateArgs(spec({ mounts: [{ source: '/host/x', target: '/etc', readOnly: false }] })),
    ).toThrow(/too broad/);
  });
});
