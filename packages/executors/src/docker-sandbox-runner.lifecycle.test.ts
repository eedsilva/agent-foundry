import { vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import { beforeEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { DockerSandboxRunner } from './docker-sandbox-runner.js';

const PINNED_IMAGE = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

function result(stdout = '', exitCode = 0, stderr = '') {
  return { stdout, stderr, exitCode };
}

beforeEach(() => execaMock.mockReset());

describe('DockerSandboxRunner policy lifecycle', () => {
  it('retains tracking when cleanup fails so destroy can be retried', async () => {
    let sidecarRemovalAttempts = 0;
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (!Array.isArray(args)) return result();
      if (args[0] === 'network' && args[1] === 'ls') return result();
      if (args[0] === 'network' && args[1] === 'create') return result('network-1');
      if (args[0] === 'network' && args[1] === 'connect') return result();
      if (args[0] === 'inspect') return result('172.30.0.2');
      if (args[0] === 'exec') return result();
      if (args[0] === 'start') return result();
      if (args[0] === 'create') {
        return result(
          args.includes('/opt/agent-foundry/network-policy.js') ? 'sidecar-1' : 'sandbox-1',
        );
      }
      if (args[0] === 'rm' && args.includes('sidecar-1')) {
        sidecarRemovalAttempts += 1;
        return sidecarRemovalAttempts === 1 ? result('', 1, 'temporary Docker error') : result();
      }
      if (args[0] === 'rm') return result('', 1, 'No such container');
      if (args[0] === 'network' && args[1] === 'rm') {
        return sidecarRemovalAttempts === 1 ? result() : result('', 1, 'No such network');
      }
      throw new Error(`Unexpected docker args: ${args.join(' ')}`);
    });

    const runner = new DockerSandboxRunner({ sidecarScriptPath: import.meta.filename });
    const spec: SandboxSpec = {
      image: PINNED_IMAGE,
      resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 32 },
      network: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
      mounts: [],
      ttlMs: 60_000,
      user: '1000:1000',
    };
    const handle = await runner.create(spec);

    await expect(runner.destroy(handle)).rejects.toThrow('temporary Docker error');
    await expect(runner.destroy(handle)).resolves.toBeUndefined();
    expect(sidecarRemovalAttempts).toBe(2);
  });

  it('removes expired labeled networks before creating a new policy sandbox', async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (!Array.isArray(args)) return result();
      if (args[0] === 'network' && args[1] === 'ls') {
        return result('expired-network 1\nfuture-network 9999999999999');
      }
      if (args[0] === 'network' && args[1] === 'rm') return result();
      if (args[0] === 'network' && args[1] === 'create') return result('network-1');
      if (args[0] === 'network' && args[1] === 'connect') return result();
      if (args[0] === 'inspect') return result('172.30.0.2');
      if (args[0] === 'exec' || args[0] === 'start' || args[0] === 'rm') return result();
      if (args[0] === 'create') {
        return result(
          args.includes('/opt/agent-foundry/network-policy.js') ? 'sidecar-1' : 'sandbox-1',
        );
      }
      throw new Error(`Unexpected docker args: ${args.join(' ')}`);
    });

    const runner = new DockerSandboxRunner({ sidecarScriptPath: import.meta.filename });
    const handle = await runner.create({
      image: PINNED_IMAGE,
      resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 32 },
      network: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
      mounts: [],
      ttlMs: 60_000,
      user: '1000:1000',
    });

    expect(execaMock).toHaveBeenCalledWith('docker', ['network', 'rm', 'expired-network'], {
      reject: false,
    });
    expect(execaMock).not.toHaveBeenCalledWith('docker', ['network', 'rm', 'future-network'], {
      reject: false,
    });
    await runner.destroy(handle);
  });

  it('does not block a new sandbox when an expired network still has active endpoints', async () => {
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (!Array.isArray(args)) return result();
      if (args[0] === 'network' && args[1] === 'ls') return result('stopping-network 1');
      if (args[0] === 'network' && args[1] === 'rm' && args[2] === 'stopping-network') {
        return result('', 1, 'network stopping-network has active endpoints');
      }
      if (args[0] === 'network' && args[1] === 'rm') return result();
      if (args[0] === 'network' && args[1] === 'create') return result('network-1');
      if (args[0] === 'network' && args[1] === 'connect') return result();
      if (args[0] === 'inspect') return result('172.30.0.2');
      if (args[0] === 'exec' || args[0] === 'start' || args[0] === 'rm') return result();
      if (args[0] === 'create') {
        return result(
          args.includes('/opt/agent-foundry/network-policy.js') ? 'sidecar-1' : 'sandbox-1',
        );
      }
      throw new Error(`Unexpected docker args: ${args.join(' ')}`);
    });
    const runner = new DockerSandboxRunner({ sidecarScriptPath: import.meta.filename });

    const handle = await runner.create({
      image: PINNED_IMAGE,
      resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 32 },
      network: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
      mounts: [],
      ttlMs: 60_000,
      user: '1000:1000',
    });

    expect(handle).toEqual({ id: 'sandbox-1' });
    await runner.destroy(handle);
  });
});
