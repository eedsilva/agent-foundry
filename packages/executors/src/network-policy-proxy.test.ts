import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkPolicyEvent } from '@agent-foundry/contracts';
import { createNetworkPolicyProxy, type NetworkPolicyProxy } from './network-policy-proxy.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startTarget(): Promise<{ authority: string; close(): Promise<void> }> {
  const server = createServer((_incoming, response) => {
    response.end('target-ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    authority: `preview.example.test:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function proxyRequest(proxy: NetworkPolicyProxy, absoluteUrl: string, host?: string) {
  const url = new URL(proxy.url);
  return new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const outgoing = request(
      {
        host: url.hostname,
        port: url.port,
        path: absoluteUrl,
        headers: host ? { host } : undefined,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

describe('createNetworkPolicyProxy', () => {
  it('forwards an exact private exception and emits only bounded policy metadata', async () => {
    const target = await startTarget();
    cleanups.push(target.close);
    const events: NetworkPolicyEvent[] = [];
    const proxy = await createNetworkPolicyProxy({
      policy: {
        mode: 'allowlist',
        purpose: 'browser',
        allowedHosts: ['preview.example.test'],
      },
      privateExceptions: new Set([target.authority]),
      resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      onEvent: (event) => events.push(event),
    });
    cleanups.push(proxy.close);

    const result = await proxyRequest(
      proxy,
      `http://${target.authority}/secret?token=redacted`,
      target.authority,
    );

    expect(result).toEqual({ statusCode: 200, body: 'target-ok' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      purpose: 'browser',
      protocol: 'http',
      decision: 'allow',
      hostname: 'preview.example.test',
    });
    expect(JSON.stringify(events[0])).not.toContain('secret');
    expect(JSON.stringify(events[0])).not.toContain('token');
  });

  it('rejects direct-IP authorities before forwarding', async () => {
    const events: NetworkPolicyEvent[] = [];
    const proxy = await createNetworkPolicyProxy({
      policy: { mode: 'allowlist', purpose: 'execution', allowedHosts: ['example.com'] },
      resolver: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
      onEvent: (event) => events.push(event),
    });
    cleanups.push(proxy.close);

    const result = await proxyRequest(proxy, 'http://169.254.169.254/latest/meta-data');

    expect(result.statusCode).toBe(403);
    expect(events.at(-1)).toMatchObject({ decision: 'deny', hostname: '169.254.169.254' });
  });

  it('rejects a Host header that disagrees with the absolute request target', async () => {
    const target = await startTarget();
    cleanups.push(target.close);
    const proxy = await createNetworkPolicyProxy({
      policy: { mode: 'allowlist', purpose: 'browser', allowedHosts: ['preview.example.test'] },
      privateExceptions: new Set([target.authority]),
      resolver: { lookup: async () => [{ address: '127.0.0.1', family: 4 }] },
      onEvent: () => undefined,
    });
    cleanups.push(proxy.close);

    const result = await proxyRequest(
      proxy,
      `http://${target.authority}/`,
      'attacker.example.test',
    );
    expect(result.statusCode).toBe(403);
  });
});
