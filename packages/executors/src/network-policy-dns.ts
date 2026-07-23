import { createSocket, type Socket } from 'node:dgram';
import { isIP, type AddressInfo } from 'node:net';
import type {
  ExecutionNetworkPolicy,
  NetworkPolicyEvent,
  NetworkPolicyPurpose,
} from '@agent-foundry/contracts';
import {
  NetworkPolicyDeniedError,
  resolveAllowedDestination,
  type NetworkPolicyResolver,
} from './network-policy.js';

export interface NetworkPolicyDnsServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

export interface NetworkPolicyDnsOptions {
  policy: ExecutionNetworkPolicy;
  resolver: NetworkPolicyResolver;
  onEvent(event: NetworkPolicyEvent): void;
  host?: string;
  port?: number;
}

interface DnsQuestion {
  hostname: string;
  type: number;
  question: Buffer;
}

function parseQuestion(packet: Buffer): DnsQuestion | null {
  if (packet.length < 17 || packet.readUInt16BE(4) !== 1) return null;
  const labels: string[] = [];
  let offset = 12;
  while (offset < packet.length) {
    const length = packet[offset]!;
    offset += 1;
    if (length === 0) break;
    if ((length & 0xc0) !== 0 || offset + length > packet.length) return null;
    labels.push(packet.subarray(offset, offset + length).toString('ascii'));
    offset += length;
  }
  if (offset + 4 > packet.length) return null;
  const type = packet.readUInt16BE(offset);
  const dnsClass = packet.readUInt16BE(offset + 2);
  if (dnsClass !== 1) return null;
  return {
    hostname: labels.join('.'),
    type,
    question: packet.subarray(12, offset + 4),
  };
}

function ipv6Bytes(address: string): Buffer | null {
  let normalized = address;
  const ipv4Start = normalized.lastIndexOf(':');
  const ipv4 = normalized
    .slice(ipv4Start + 1)
    .split('.')
    .map(Number);
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    normalized = `${normalized.slice(0, ipv4Start)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const [left = '', right = ''] = normalized.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const parts = normalized.includes('::')
    ? [
        ...leftParts,
        ...Array.from({ length: 8 - leftParts.length - rightParts.length }, () => '0'),
        ...rightParts,
      ]
    : leftParts;
  if (parts.length !== 8) return null;
  const result = Buffer.alloc(16);
  parts.forEach((part, index) => result.writeUInt16BE(Number.parseInt(part, 16), index * 2));
  return result;
}

function addressBytes(address: string, type: number): Buffer | null {
  if (type === 1 && isIP(address) === 4) return Buffer.from(address.split('.').map(Number));
  if (type === 28 && isIP(address) === 6) return ipv6Bytes(address);
  return null;
}

function response(packet: Buffer, question: DnsQuestion, answers: string[], rcode: 0 | 3): Buffer {
  const encodedAnswers = answers
    .map((address) => addressBytes(address, question.type))
    .filter((address): address is Buffer => address !== null)
    .map((address) => {
      const record = Buffer.alloc(12 + address.length);
      record.writeUInt16BE(0xc00c, 0);
      record.writeUInt16BE(question.type, 2);
      record.writeUInt16BE(1, 4);
      record.writeUInt32BE(30, 6);
      record.writeUInt16BE(address.length, 10);
      address.copy(record, 12);
      return record;
    });
  const header = Buffer.alloc(12);
  packet.copy(header, 0, 0, 2);
  header.writeUInt16BE(rcode === 0 ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(encodedAnswers.length, 6);
  return Buffer.concat([header, question.question, ...encodedAnswers]);
}

function policyEvent(input: {
  purpose: NetworkPolicyPurpose;
  decision: 'allow' | 'deny';
  hostname: string;
  addresses: string[];
  reason: string;
}): NetworkPolicyEvent {
  return {
    timestamp: new Date().toISOString(),
    purpose: input.purpose,
    protocol: 'dns',
    decision: input.decision,
    hostname: input.hostname.slice(0, 253) || 'invalid',
    port: 53,
    addresses: input.addresses.slice(0, 32),
    reason: input.reason.slice(0, 256),
  };
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

export async function createNetworkPolicyDnsServer(
  options: NetworkPolicyDnsOptions,
): Promise<NetworkPolicyDnsServer> {
  const socket = createSocket('udp4');
  socket.on('message', (packet, remote) => {
    void (async () => {
      const question = parseQuestion(packet);
      if (!question || ![1, 28].includes(question.type)) return;
      try {
        const destination = await resolveAllowedDestination({
          hostname: question.hostname,
          port: 53,
          allowedHosts: new Set(
            options.policy.mode === 'allowlist' ? options.policy.allowedHosts : [],
          ),
          resolver: options.resolver,
        });
        options.onEvent(
          policyEvent({
            purpose: options.policy.purpose,
            decision: 'allow',
            hostname: destination.hostname,
            addresses: destination.addresses,
            reason: 'allowlisted public DNS answer',
          }),
        );
        socket.send(
          response(packet, question, destination.addresses, 0),
          remote.port,
          remote.address,
        );
      } catch (error) {
        const denied = error instanceof NetworkPolicyDeniedError ? error : undefined;
        options.onEvent(
          policyEvent({
            purpose: options.policy.purpose,
            decision: 'deny',
            hostname: question.hostname,
            addresses: denied?.addresses ?? [],
            reason: denied?.message ?? 'policy evaluation failed',
          }),
        );
        socket.send(response(packet, question, [], 3), remote.port, remote.address);
      }
    })();
  });
  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(options.port ?? 53, host, () => {
      socket.off('error', reject);
      resolve();
    });
  });
  const bound = socket.address() as AddressInfo;
  return { host, port: bound.port, close: () => closeSocket(socket) };
}
