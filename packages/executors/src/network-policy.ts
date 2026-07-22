import { isIP } from 'node:net';

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function normalizeHostname(hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  const labels = normalized.split('.');
  if (
    hostname.length < 1 ||
    hostname.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => HOST_LABEL.test(label)) ||
    labels.every((label) => /^\d+$/.test(label))
  ) {
    return null;
  }
  return normalized;
}

export interface NetworkPolicyResolver {
  lookup(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>>;
}

export class NetworkPolicyDeniedError extends Error {
  readonly addresses: string[];

  constructor(message: string, addresses: string[] = []) {
    super(message);
    this.name = 'NetworkPolicyDeniedError';
    this.addresses = addresses;
  }
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split('.').map(Number);
}

function parseIpv6(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  const ipv4Index = normalized.lastIndexOf(':');
  const ipv4Tail = normalized.slice(ipv4Index + 1);
  const ipv4 = parseIpv4(ipv4Tail);
  if (ipv4) {
    normalized = `${normalized.slice(0, ipv4Index)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const [left = '', right = ''] = normalized.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const parts = normalized.includes('::')
    ? [...leftParts, ...Array.from({ length: missing }, () => '0'), ...rightParts]
    : leftParts;
  if (parts.length !== 8) return null;
  return parts.flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [value >> 8, value & 0xff];
  });
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== (prefix[index] ?? 0)) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes]! & mask) === ((prefix[wholeBytes] ?? 0) & mask);
}

function isPublicIpv4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return !(
    a === 0 ||
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

const BLOCKED_IPV6_PREFIXES: Array<{ bytes: number[]; bits: number }> = [
  { bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], bits: 128 },
  { bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], bits: 128 },
  { bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], bits: 96 },
  { bytes: [0x00, 0x64, 0xff, 0x9b], bits: 32 },
  { bytes: [0x01, 0x00], bits: 64 },
  { bytes: [0x20, 0x01], bits: 23 },
  { bytes: [0x20, 0x01, 0x0d, 0xb8], bits: 32 },
  { bytes: [0x20, 0x02], bits: 16 },
  { bytes: [0x3f, 0xff, 0x00], bits: 20 },
  { bytes: [0x5f, 0x00], bits: 16 },
  { bytes: [0xfc], bits: 7 },
  { bytes: [0xfe, 0x80], bits: 10 },
  { bytes: [0xfe, 0xc0], bits: 10 },
  { bytes: [0xff], bits: 8 },
];

export function isPublicAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;
  return !BLOCKED_IPV6_PREFIXES.some((prefix) => hasPrefix(ipv6, prefix.bytes, prefix.bits));
}

export interface ResolveAllowedDestinationInput {
  hostname: string;
  port: number;
  allowedHosts: ReadonlySet<string>;
  resolver: NetworkPolicyResolver;
  privateExceptions?: ReadonlySet<string>;
}

export interface ResolvedDestination {
  hostname: string;
  port: number;
  addresses: string[];
  selectedAddress: string;
}

export async function resolveAllowedDestination(
  input: ResolveAllowedDestinationInput,
): Promise<ResolvedDestination> {
  const normalized = normalizeHostname(input.hostname);
  const privateException = input.privateExceptions?.has(
    `${input.hostname.toLowerCase()}:${input.port}`,
  );
  if (!privateException && (!normalized || !input.allowedHosts.has(normalized))) {
    throw new NetworkPolicyDeniedError('hostname is not allowlisted');
  }
  const hostname = normalized ?? input.hostname.toLowerCase();
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new NetworkPolicyDeniedError('port is invalid');
  }

  let answers: Awaited<ReturnType<NetworkPolicyResolver['lookup']>>;
  try {
    answers = await input.resolver.lookup(hostname);
  } catch {
    throw new NetworkPolicyDeniedError('DNS resolution failed');
  }
  const addresses = answers.map((answer) => answer.address);
  if (addresses.length === 0) throw new NetworkPolicyDeniedError('DNS returned no addresses');
  if (!privateException && addresses.some((address) => !isPublicAddress(address))) {
    throw new NetworkPolicyDeniedError('DNS returned a non-public address', addresses);
  }
  return {
    hostname,
    port: input.port,
    addresses,
    selectedAddress: addresses[0]!,
  };
}
