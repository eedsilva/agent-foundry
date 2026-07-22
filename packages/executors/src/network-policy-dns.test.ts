import { createSocket } from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkPolicyEvent } from '@agent-foundry/contracts';
import { createNetworkPolicyDnsServer, type NetworkPolicyDnsServer } from './network-policy-dns.js';

const servers: NetworkPolicyDnsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function query(hostname: string, type = 1): Buffer {
  const labels = hostname.split('.').flatMap((label) => [label.length, ...Buffer.from(label)]);
  return Buffer.from([
    0x12,
    0x34,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    ...labels,
    0x00,
    (type >> 8) & 0xff,
    type & 0xff,
    0x00,
    0x01,
  ]);
}

async function send(server: NetworkPolicyDnsServer, hostname: string): Promise<Buffer> {
  const socket = createSocket('udp4');
  return new Promise((resolve, reject) => {
    socket.once('message', (message) => {
      socket.close();
      resolve(message);
    });
    socket.once('error', reject);
    socket.send(query(hostname), server.port, server.host);
  });
}

describe('createNetworkPolicyDnsServer', () => {
  it('returns public answers for an exact allowlisted hostname and emits an allow event', async () => {
    const events: NetworkPolicyEvent[] = [];
    const server = await createNetworkPolicyDnsServer({
      policy: { mode: 'allowlist', purpose: 'execution', allowedHosts: ['example.com'] },
      resolver: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
      onEvent: (event) => events.push(event),
      host: '127.0.0.1',
      port: 0,
    });
    servers.push(server);

    const response = await send(server, 'example.com');

    expect(response[3]! & 0x0f).toBe(0);
    expect(response.readUInt16BE(6)).toBe(1);
    expect(response.subarray(-4)).toEqual(Buffer.from([1, 1, 1, 1]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      protocol: 'dns',
      decision: 'allow',
      hostname: 'example.com',
    });
  });

  it('returns NXDOMAIN and an observable deny for forbidden and private answers', async () => {
    const events: NetworkPolicyEvent[] = [];
    const server = await createNetworkPolicyDnsServer({
      policy: { mode: 'allowlist', purpose: 'execution', allowedHosts: ['example.com'] },
      resolver: { lookup: async () => [{ address: '169.254.169.254', family: 4 }] },
      onEvent: (event) => events.push(event),
      host: '127.0.0.1',
      port: 0,
    });
    servers.push(server);

    const forbidden = await send(server, 'other.example.com');
    const privateAnswer = await send(server, 'example.com');

    expect(forbidden[3]! & 0x0f).toBe(3);
    expect(privateAnswer[3]! & 0x0f).toBe(3);
    expect(events).toEqual([
      expect.objectContaining({ decision: 'deny', hostname: 'other.example.com', addresses: [] }),
      expect.objectContaining({
        decision: 'deny',
        hostname: 'example.com',
        addresses: ['169.254.169.254'],
      }),
    ]);
  });
});
