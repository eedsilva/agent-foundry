import type { ProjectEvent } from '@agent-foundry/contracts';

const SENSITIVE_WORD =
  /^(?:token|secret|secrets|password|passwd|credential|credentials|authorization|auth|bearer|cookie|cookies|session|apikey)$/i;

const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const RAW_SECRET = /(\b(?:authorization|token|cookie)\s*[:=]\s*)(?:basic\s+|bearer\s+)?[^\s,;]+/gi;

const KEY_PREFIXES = new Set(['api', 'access', 'private']);

function isSensitiveKey(key: string): boolean {
  const words = key.split(/[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  if (words.some((word) => SENSITIVE_WORD.test(word))) return true;
  const lower = words.map((word) => word.toLowerCase());
  return lower.some((word, index) => KEY_PREFIXES.has(word) && lower[index + 1] === 'key');
}

export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce(
    (acc, pattern) => acc.replace(pattern, '[REDACTED]'),
    value.replace(RAW_SECRET, '$1[REDACTED]'),
  );
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        isSensitiveKey(key) ? '[REDACTED]' : redactValue(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactUnknown(value: unknown): unknown {
  return redactValue(value, 0);
}

export function redactEvent(event: ProjectEvent): ProjectEvent {
  return {
    ...event,
    message: redactString(event.message),
    data: redactUnknown(event.data) as ProjectEvent['data'],
  };
}
