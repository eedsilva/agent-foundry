// Generated projects have no SMTP configured (harness/stacks/supabase.md:
// email/password only, no external services in v1), so signup must not wait
// on an email confirmation link nobody can deliver. This forces the local
// stack's [auth.email] section to enable_confirmations = false, matching the
// scaffold's sign-up flow (harness/scaffolds/nextjs/app/sign-up/page.tsx),
// which logs the user straight in.
const SECTION_HEADER_RE =
  /^[ \t]*\[[ \t]*(?:auth\.email|'auth\.email'|"auth\.email")[ \t]*\][ \t]*(?:#.*)?\r?$/m;
const NEXT_SECTION_RE = /\r?\n(?=[ \t]*\[[^\]\r\n]+\][ \t]*(?:#.*)?\r?(?:\n|$))/;
const CONFIRMATIONS_KEY_RE = /^([ \t]*)enable_confirmations[ \t]*=.*$/m;

export function configureGeneratedAuth(config: string): string {
  const sectionMatch = config.match(SECTION_HEADER_RE);
  if (!sectionMatch || sectionMatch.index === undefined) {
    const trimmed = config.endsWith('\n') ? config : `${config}\n`;
    return `${trimmed}\n[auth.email]\nenable_confirmations = false\n`;
  }

  const afterHeader = sectionMatch.index + sectionMatch[0].length;
  const nextSectionOffset = config.slice(afterHeader).search(NEXT_SECTION_RE);
  const sectionEnd = nextSectionOffset === -1 ? config.length : afterHeader + nextSectionOffset;
  const body = config.slice(afterHeader, sectionEnd);

  const keyMatch = body.match(CONFIRMATIONS_KEY_RE);
  const updatedBody = keyMatch
    ? body.replace(CONFIRMATIONS_KEY_RE, `${keyMatch[1]}enable_confirmations = false`)
    : `${body.endsWith('\n') ? body : `${body}\n`}enable_confirmations = false\n`;

  return config.slice(0, afterHeader) + updatedBody + config.slice(sectionEnd);
}
