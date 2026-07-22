import { describe, expect, it, vi } from 'vitest';
import {
  NetworkPolicyDeniedError,
  isPublicAddress,
  resolveAllowedDestination,
  type NetworkPolicyResolver,
} from './network-policy.js';

describe('isPublicAddress', () => {
  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b:1::1',
    '100::1',
    '2001:db8::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe('resolveAllowedDestination', () => {
  it('permits only an exact system-supplied private authority exception', async () => {
    await expect(
      resolveAllowedDestination({
        hostname: '127.0.0.1',
        port: 4100,
        allowedHosts: new Set(),
        privateExceptions: new Set(['127.0.0.1:4100']),
        resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      }),
    ).resolves.toMatchObject({ selectedAddress: '127.0.0.1' });

    await expect(
      resolveAllowedDestination({
        hostname: '127.0.0.1',
        port: 4101,
        allowedHosts: new Set(),
        privateExceptions: new Set(['127.0.0.1:4100']),
        resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyDeniedError);
  });

  it('rejects a mixed public/private answer set', async () => {
    const resolver: NetworkPolicyResolver = {
      lookup: vi.fn(async () => [
        { address: '1.1.1.1', family: 4 as const },
        { address: '169.254.169.254', family: 4 as const },
      ]),
    };

    await expect(
      resolveAllowedDestination({
        hostname: 'example.com',
        port: 443,
        allowedHosts: new Set(['example.com']),
        resolver,
      }),
    ).rejects.toMatchObject({
      name: 'NetworkPolicyDeniedError',
      addresses: ['1.1.1.1', '169.254.169.254'],
    });
  });

  it('re-resolves every connection and rejects a private rebinding answer', async () => {
    const lookup = vi
      .fn<NetworkPolicyResolver['lookup']>()
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const input = {
      hostname: 'example.com',
      port: 443,
      allowedHosts: new Set(['example.com']),
      resolver: { lookup },
    };

    await expect(resolveAllowedDestination(input)).resolves.toMatchObject({
      selectedAddress: '1.1.1.1',
    });
    await expect(resolveAllowedDestination(input)).rejects.toBeInstanceOf(NetworkPolicyDeniedError);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it.each(['other.example.com', '127.0.0.1', 'localhost'])(
    'denies unlisted host %s',
    async (hostname) => {
      await expect(
        resolveAllowedDestination({
          hostname,
          port: 443,
          allowedHosts: new Set(['example.com']),
          resolver: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
        }),
      ).rejects.toBeInstanceOf(NetworkPolicyDeniedError);
    },
  );
});
