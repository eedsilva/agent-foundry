// Reuses redaction.ts's shape-based patterns (they're the repo's one
// source of truth for what a secret *looks like*) and adds exact-value
// matching against secrets whose real value is already known at scan
// time (e.g. planted in a leak-scanner test, or read from a project's
// resolved .env before a CI check).
const VALUE_PATTERNS = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export interface SecretMatch {
  kind: 'pattern' | 'exact-value';
  index: number;
}

export function scanForSecrets(content: string, knownSecrets: string[] = []): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const pattern of VALUE_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match.index !== undefined) matches.push({ kind: 'pattern', index: match.index });
    }
  }
  for (const secret of knownSecrets) {
    if (!secret) continue;
    let index = content.indexOf(secret);
    while (index !== -1) {
      matches.push({ kind: 'exact-value', index });
      index = content.indexOf(secret, index + 1);
    }
  }
  return matches.sort((a, b) => a.index - b.index);
}
