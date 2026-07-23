import { lookup } from 'node:dns/promises';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type {
  ExecutionNetworkPolicy,
  NetworkPolicyEvent,
  NetworkPolicyPurpose,
} from '@agent-foundry/contracts';
import {
  NetworkPolicyDeniedError,
  resolveAllowedDestination,
  type NetworkPolicyResolver,
  type ResolvedDestination,
} from './network-policy.js';

export interface NetworkPolicyProxy {
  url: string;
  close(): Promise<void>;
}

export interface NetworkPolicyProxyOptions {
  policy: ExecutionNetworkPolicy;
  privateExceptions?: ReadonlySet<string>;
  allowedAuthorities?: ReadonlySet<string>;
  resolver?: NetworkPolicyResolver;
  onEvent(event: NetworkPolicyEvent): void;
  host?: string;
  port?: number;
}

const defaultResolver: NetworkPolicyResolver = {
  async lookup(hostname) {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
  },
};

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function authority(hostname: string, port: number): string {
  return `${hostname.toLowerCase()}:${port}`;
}

function event(input: {
  purpose: NetworkPolicyPurpose;
  protocol: NetworkPolicyEvent['protocol'];
  decision: NetworkPolicyEvent['decision'];
  hostname: string;
  port: number;
  addresses?: string[];
  reason: string;
}): NetworkPolicyEvent {
  return {
    timestamp: new Date().toISOString(),
    purpose: input.purpose,
    protocol: input.protocol,
    decision: input.decision,
    hostname: input.hostname.slice(0, 253) || 'invalid',
    port: Math.min(65_535, Math.max(1, input.port || 1)),
    addresses: (input.addresses ?? []).slice(0, 32),
    reason: input.reason.slice(0, 256),
  };
}

function sanitizedHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const result = { ...headers, host };
  delete result['proxy-authorization'];
  delete (result as Record<string, string | string[] | undefined>)['proxy-connection'];
  return result;
}

function writeDenied(response: {
  writeHead(statusCode: number): unknown;
  end(body?: string): unknown;
}): void {
  response.writeHead(403);
  response.end('Forbidden by network policy');
}

async function resolveForProxy(
  options: NetworkPolicyProxyOptions,
  hostname: string,
  port: number,
  protocol: NetworkPolicyEvent['protocol'],
): Promise<ResolvedDestination> {
  const allowedHosts = new Set(
    options.policy.mode === 'allowlist' ? options.policy.allowedHosts : [],
  );
  try {
    const destination = await resolveAllowedDestination({
      hostname,
      port,
      allowedHosts,
      resolver: options.resolver ?? defaultResolver,
      ...(options.privateExceptions ? { privateExceptions: options.privateExceptions } : {}),
    });
    options.onEvent(
      event({
        purpose: options.policy.purpose,
        protocol,
        decision: 'allow',
        hostname: destination.hostname,
        port,
        addresses: destination.addresses,
        reason: 'allowlisted public destination',
      }),
    );
    return destination;
  } catch (error) {
    const denied = error instanceof NetworkPolicyDeniedError ? error : undefined;
    options.onEvent(
      event({
        purpose: options.policy.purpose,
        protocol,
        decision: 'deny',
        hostname,
        port,
        ...(denied ? { addresses: denied.addresses } : {}),
        reason: denied?.message ?? 'policy evaluation failed',
      }),
    );
    throw error;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}

export async function createNetworkPolicyProxy(
  options: NetworkPolicyProxyOptions,
): Promise<NetworkPolicyProxy> {
  const server = createServer(async (incoming, response) => {
    let target: URL;
    try {
      target = new URL(incoming.url ?? '');
      if (target.protocol !== 'http:' || target.username || target.password) throw new Error();
    } catch {
      options.onEvent(
        event({
          purpose: options.policy.purpose,
          protocol: 'http',
          decision: 'deny',
          hostname: 'invalid',
          port: 80,
          reason: 'invalid absolute HTTP target',
        }),
      );
      writeDenied(response);
      return;
    }
    const port = effectivePort(target);
    const targetAuthority = authority(target.hostname, port);
    const privateException = options.privateExceptions?.has(targetAuthority) ?? false;
    const allowedAuthority = options.allowedAuthorities?.has(targetAuthority) ?? false;
    const hostHeader = incoming.headers.host?.toLowerCase();
    if (
      (!privateException && !allowedAuthority && port !== 80) ||
      !hostHeader ||
      authorityFromHeader(hostHeader, 80) !== targetAuthority
    ) {
      options.onEvent(
        event({
          purpose: options.policy.purpose,
          protocol: 'http',
          decision: 'deny',
          hostname: target.hostname,
          port,
          reason:
            !privateException && !allowedAuthority && port !== 80
              ? 'HTTP port is not allowed'
              : 'Host header mismatch',
        }),
      );
      writeDenied(response);
      return;
    }
    try {
      const destination = await resolveForProxy(options, target.hostname, port, 'http');
      const outgoing = request(
        {
          hostname: destination.selectedAddress,
          port,
          method: incoming.method,
          path: `${target.pathname}${target.search}`,
          headers: sanitizedHeaders(incoming.headers, target.host),
        },
        (upstream) => {
          response.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(response);
        },
      );
      outgoing.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('Upstream connection failed');
      });
      incoming.pipe(outgoing);
    } catch {
      writeDenied(response);
    }
  });

  server.on('connect', (incoming, client, head) => {
    void (async () => {
      let target: URL;
      try {
        target = new URL(`http://${incoming.url ?? ''}`);
      } catch {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const port = effectivePort(target);
      const targetAuthority = authority(target.hostname, port);
      const privateException = options.privateExceptions?.has(targetAuthority) ?? false;
      const allowedAuthority = options.allowedAuthorities?.has(targetAuthority) ?? false;
      if (
        (!privateException && !allowedAuthority && port !== 443) ||
        target.username ||
        target.password
      ) {
        options.onEvent(
          event({
            purpose: options.policy.purpose,
            protocol: 'connect',
            decision: 'deny',
            hostname: target.hostname,
            port,
            reason: 'CONNECT authority is not allowed',
          }),
        );
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      try {
        const destination = await resolveForProxy(options, target.hostname, port, 'connect');
        const upstream = connect({ host: destination.selectedAddress, port });
        upstream.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.once('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
      } catch {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      }
    })();
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://${host}:${address.port}`,
    close: () => closeServer(server),
  };
}

function authorityFromHeader(header: string, defaultPort: number): string {
  try {
    const parsed = new URL(`http://${header}`);
    return authority(parsed.hostname, parsed.port ? Number(parsed.port) : defaultPort);
  } catch {
    return 'invalid:1';
  }
}
