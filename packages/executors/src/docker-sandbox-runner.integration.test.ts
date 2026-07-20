import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { DockerSandboxRunner, SANDBOX_WORKSPACE_PATH } from './docker-sandbox-runner.js';

const PINNED_IMAGE = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

async function dockerAvailable(): Promise<boolean> {
  try {
    await execa('docker', ['version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: PINNED_IMAGE,
    resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 32 },
    network: { mode: 'none', allowedHosts: [] },
    mounts: [],
    ttlMs: 60_000,
    user: '1000:1000',
    ...overrides,
  };
}

describe.skipIf(!hasDocker)(
  'DockerSandboxRunner (integration)',
  () => {
    const runner = new DockerSandboxRunner();
    const created: string[] = [];

    afterEach(async () => {
      while (created.length > 0) {
        const id = created.pop();
        if (id) await execa('docker', ['rm', '-f', id], { reject: false });
      }
    });

    it('creates a running container matching the hardening flags', async () => {
      const handle = await runner.create(spec());
      created.push(handle.id);

      const inspect = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{.State.Running}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}',
      ]);
      expect(inspect.stdout.trim()).toBe('true 134217728 500000000 32 none true false');

      const capDrop = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{json .HostConfig.CapDrop}}',
      ]);
      expect(JSON.parse(capDrop.stdout)).toEqual(['ALL']);

      const tmpfs = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{json .HostConfig.Tmpfs}}',
      ]);
      expect(JSON.parse(tmpfs.stdout)).toEqual({
        [SANDBOX_WORKSPACE_PATH]: 'rw,nosuid,nodev,size=64m,mode=1777',
        '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
      });

      await runner.destroy(handle);
      created.pop();
    });

    it('destroy is idempotent for the same handle', async () => {
      const handle = await runner.create(spec());
      await runner.destroy(handle);
      await expect(runner.destroy(handle)).resolves.toBeUndefined();
    });

    it('rejects a spec with an unpinned image before touching Docker', async () => {
      await expect(runner.create(spec({ image: 'node:22-bookworm-slim' }))).rejects.toThrow(
        /pinned by digest/,
      );
    });
  },
  60_000,
);
