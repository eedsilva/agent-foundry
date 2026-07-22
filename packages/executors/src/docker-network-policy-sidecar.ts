import { lookup } from 'node:dns/promises';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  MAX_NETWORK_POLICY_EVENTS,
  type ExecutionNetworkPolicy,
  type NetworkPolicyEvent,
} from '@agent-foundry/contracts';
import { createNetworkPolicyDnsServer } from './network-policy-dns.js';
import { createNetworkPolicyProxy } from './network-policy-proxy.js';
import type { NetworkPolicyResolver } from './network-policy.js';

const POLICY_ENV = 'AGENT_FOUNDRY_NETWORK_POLICY';
const POLICY_TTL_ENV = 'AGENT_FOUNDRY_POLICY_TTL_MS';
export const POLICY_SIDECAR_READY_PATH = '/tmp/agent-foundry-network-policy-ready';

function readPolicy(): ExecutionNetworkPolicy {
  const encoded = process.env[POLICY_ENV];
  if (!encoded) throw new Error(`${POLICY_ENV} is required`);
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  if (!value || typeof value !== 'object') throw new Error('Network policy must be an object');
  const candidate = value as Record<string, unknown>;
  if (
    candidate.mode !== 'allowlist' ||
    !['execution', 'dependency-install', 'browser'].includes(String(candidate.purpose)) ||
    !Array.isArray(candidate.allowedHosts) ||
    candidate.allowedHosts.length === 0 ||
    !candidate.allowedHosts.every((host) => typeof host === 'string')
  ) {
    throw new Error('Sidecar requires a validated allowlist policy');
  }
  return candidate as unknown as ExecutionNetworkPolicy;
}

const resolver: NetworkPolicyResolver = {
  async lookup(hostname) {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 }));
  },
};

export function createBoundedEventLogger(
  write: (line: string) => void = (line) => console.log(line),
): (event: NetworkPolicyEvent) => void {
  let count = 0;
  return (event) => {
    if (count >= MAX_NETWORK_POLICY_EVENTS) return;
    count += 1;
    write(JSON.stringify(event));
  };
}

export interface NetworkPolicySidecarRuntimeOptions {
  policy: ExecutionNetworkPolicy;
  resolver: NetworkPolicyResolver;
  onEvent(event: NetworkPolicyEvent): void;
  createProxy?: typeof createNetworkPolicyProxy;
  createDns?: typeof createNetworkPolicyDnsServer;
  onReady?: () => Promise<void>;
}

export async function startNetworkPolicySidecar(
  options: NetworkPolicySidecarRuntimeOptions,
): Promise<{ close(): Promise<void> }> {
  const proxy = await (options.createProxy ?? createNetworkPolicyProxy)({
    policy: options.policy,
    resolver: options.resolver,
    onEvent: options.onEvent,
    host: '0.0.0.0',
    port: 3128,
  });
  let dns: Awaited<ReturnType<typeof createNetworkPolicyDnsServer>> | undefined;
  try {
    dns = await (options.createDns ?? createNetworkPolicyDnsServer)({
      policy: options.policy,
      resolver: options.resolver,
      onEvent: options.onEvent,
      host: '0.0.0.0',
      port: 53,
    });
    await (options.onReady ?? (() => writeFile(POLICY_SIDECAR_READY_PATH, 'ready\n')))();
  } catch (error) {
    await Promise.all([proxy.close().catch(() => undefined), dns?.close().catch(() => undefined)]);
    throw error;
  }

  const close = async (): Promise<void> => {
    await Promise.all([proxy.close(), dns.close()]);
  };
  return { close };
}

function readTtlMs(): number {
  const value = Number(process.env[POLICY_TTL_ENV]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${POLICY_TTL_ENV} must be a positive integer`);
  }
  return value;
}

async function main(): Promise<void> {
  const ttlMs = readTtlMs();
  const runtime = await startNetworkPolicySidecar({
    policy: readPolicy(),
    resolver,
    onEvent: createBoundedEventLogger(),
  });
  console.error('agent-foundry network policy sidecar ready');
  const shutdown = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  const expiry = setTimeout(shutdown, ttlMs);
  expiry.unref();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
