import type { ProjectEvent } from '@agent-foundry/contracts';

const SENSITIVE_KEY =
  /(?:^|[-_.])(?:token|secret|password|passwd|credential|credentials|authorization|auth|apikey|api[-_]key|access[-_]key|private[-_]key|bearer|cookie|session)(?:$|[-_.])/i;

const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactString(value: string): string {
  return VALUE_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), value);
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(entry, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactEvent(event: ProjectEvent): ProjectEvent {
  return {
    ...event,
    message: redactString(event.message),
    data: redactValue(event.data, 0) as ProjectEvent['data'],
  };
}
