import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkPolicyEvent } from '@agent-foundry/contracts';
import {
  createBoundedEventLogger,
  startNetworkPolicySidecar,
} from './docker-network-policy-sidecar.js';

const EVENT: NetworkPolicyEvent = {
  timestamp: '2026-07-22T12:00:00.000Z',
  purpose: 'execution',
  protocol: 'dns',
  decision: 'deny',
  hostname: 'blocked.example',
  port: 53,
  addresses: [],
  reason: 'not allowlisted',
};

describe('network policy sidecar runtime', () => {
  it('builds as one self-contained file with only Node built-in imports', async () => {
    const packageDir = fileURLToPath(new URL('..', import.meta.url));
    await execa('npm', ['run', 'build:sidecar'], { cwd: packageDir });
    const output = await readFile(
      join(packageDir, 'dist/docker-network-policy-sidecar.js'),
      'utf8',
    );
    const imports = [...output.matchAll(/\b(?:from|import)\s*["']([^"']+)["']/g)].map(
      (match) => match[1]!,
    );

    expect(imports.filter((specifier) => !specifier.startsWith('node:'))).toEqual([]);
  });

  it('caps audit output at the shared event limit', () => {
    const write = vi.fn();
    const log = createBoundedEventLogger(write);

    for (let index = 0; index < 1_005; index += 1) log(EVENT);

    expect(write).toHaveBeenCalledTimes(1_000);
  });

  it('closes the proxy and never marks ready when DNS startup fails', async () => {
    const closeProxy = vi.fn(async () => undefined);
    const onReady = vi.fn(async () => undefined);

    await expect(
      startNetworkPolicySidecar({
        policy: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
        resolver: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
        onEvent: vi.fn(),
        createProxy: vi.fn(async () => ({ url: 'http://127.0.0.1:3128', close: closeProxy })),
        createDns: vi.fn(async () => {
          throw new Error('DNS bind failed');
        }),
        onReady,
      }),
    ).rejects.toThrow('DNS bind failed');

    expect(closeProxy).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('closes both listeners when the readiness marker cannot be written', async () => {
    const closeProxy = vi.fn(async () => undefined);
    const closeDns = vi.fn(async () => undefined);

    await expect(
      startNetworkPolicySidecar({
        policy: { mode: 'allowlist', allowedHosts: ['example.com'], purpose: 'execution' },
        resolver: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
        onEvent: vi.fn(),
        createProxy: vi.fn(async () => ({ url: 'http://127.0.0.1:3128', close: closeProxy })),
        createDns: vi.fn(async () => ({ host: '127.0.0.1', port: 53, close: closeDns })),
        onReady: vi.fn(async () => {
          throw new Error('ready marker failed');
        }),
      }),
    ).rejects.toThrow('ready marker failed');

    expect(closeProxy).toHaveBeenCalledOnce();
    expect(closeDns).toHaveBeenCalledOnce();
  });
});
