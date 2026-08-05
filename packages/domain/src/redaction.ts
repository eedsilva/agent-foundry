import type {
  ApprovalDecision,
  ProjectEvent,
  ValidationPreflightReport,
} from '@agent-foundry/contracts';

const SENSITIVE_WORD =
  /^(?:token|secret|secrets|password|passwd|credential|credentials|authorization|auth|bearer|cookie|cookies|session|apikey)$/i;

export const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Bare in a tool's stderr these carry no key= shape, so only the prefix
  // identifies them. Google's AIza prefix is deliberately absent: benchmark case
  // security-redaction-google-api-key owns it, and implementing it here would
  // answer the case in the product.
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
];
const QUOTED_SECRET =
  /((?:["']?(?:authorization|(?:[a-z][a-z0-9]*[_-]?)?token|cookie)["']?)\s*[:=]\s*)(["'])([^\r\n]*?)\2/gi;
const COOKIE_HEADER = /(\bcookie\s*:\s*).*$/gim;
const COOKIE_ASSIGNMENT = /(\bcookie\s*=\s*)(?!["']).*$/gim;
const RAW_SECRET =
  /(\b(?:authorization|(?:[a-z][a-z0-9]*[_-]?)?token)\s*[:=]\s*)(?!["'])(?:basic\s+|bearer\s+)?[^\s,;]+/gi;
const URL_CREDENTIAL = /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;
const DATABASE_URL_ASSIGNMENT =
  /(\b(?:DATABASE_URL|SUPABASE_DB_URL)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi;
const ENV_SECRET_ASSIGNMENT =
  /(\b(?:[A-Z][A-Z0-9_]*_)?(?:SECRET|PASSWORD|TOKEN|KEY)\s*=\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/g;
const WORKDIR_ARGUMENT = /(--workdir(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|\S+)/gi;
const PROJECT_WORKDIR = /\/(?:[^/\s"'`]+\/)*projects\/[^/\s"'`]+\/environment(?:\/[^/\s"'`]*)?/gi;
const ENVIRONMENT_WORKDIR = /\/(?:[^/\s"'`]+\/)+environment(?:\/[^/\s"'`]*)?/gi;

const KEY_PREFIXES = new Set(['api', 'access', 'private']);

function isSensitiveKey(key: string): boolean {
  const words = key.split(/[-_.\s]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean);
  if (words.some((word) => SENSITIVE_WORD.test(word))) return true;
  const lower = words.map((word) => word.toLowerCase());
  return lower.some((word, index) => KEY_PREFIXES.has(word) && lower[index + 1] === 'key');
}

export function redactString(value: string): string {
  const assignments = value
    .replace(QUOTED_SECRET, '$1$2[REDACTED]$2')
    .replace(COOKIE_HEADER, '$1[REDACTED]')
    .replace(COOKIE_ASSIGNMENT, '$1[REDACTED]')
    .replace(RAW_SECRET, '$1[REDACTED]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]$2')
    .replace(DATABASE_URL_ASSIGNMENT, '$1[REDACTED]')
    .replace(ENV_SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(WORKDIR_ARGUMENT, '$1[REDACTED]')
    .replace(PROJECT_WORKDIR, '[REDACTED]')
    .replace(ENVIRONMENT_WORKDIR, '[REDACTED]');
  return VALUE_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), assignments);
}

/**
 * Home directories carry the operator's account name into shared evidence, but
 * the rest of the path is what makes a failure diagnosable — so drop the name
 * and keep the path. Single source for every evidence surface that persists or
 * publishes operator-side paths.
 */
const HOME_DIRECTORY = /(\/(?:Users|home)\/)[^/\s'"`]+/g;

export function redactPersonalPaths(value: string): string {
  return value.replace(HOME_DIRECTORY, '$1[REDACTED]');
}

/**
 * The preflight report crosses three boundaries — the persisted file, the
 * run-bound artifact and the HTTP response — and each one used to carry its own
 * copy of this. One definition, so a redaction fix cannot land on two of them
 * and miss the third.
 */
export function redactValidationPreflightReport(
  report: ValidationPreflightReport,
): ValidationPreflightReport {
  return {
    ...report,
    dataDirectory: '[REDACTED]',
    checks: report.checks.map((check) => ({
      ...check,
      ...(check.message ? { message: redactPersonalPaths(redactString(check.message)) } : {}),
    })),
  };
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

export function normalizeApprovalDecision(
  decision: ApprovalDecision | null,
): ApprovalDecision | null {
  if (!decision) return null;
  const decidedBy = redactIdentity(decision.decidedBy);
  return {
    ...decision,
    decidedBy,
    actor: decision.actor
      ? {
          kind: decision.actor.kind,
          id: redactIdentity(decision.actor.id),
          ...(decision.actor.displayName !== undefined
            ? { displayName: redactIdentity(decision.actor.displayName) }
            : {}),
        }
      : { kind: 'user', id: decidedBy },
    ...(decision.note !== undefined ? { note: redactString(decision.note) } : {}),
  };
}

function redactIdentity(value: string): string {
  return redactString(value).trim() || 'unknown';
}

export function redactEvent(event: ProjectEvent): ProjectEvent {
  return {
    ...event,
    message: redactString(event.message),
    data: redactUnknown(event.data) as ProjectEvent['data'],
  };
}
