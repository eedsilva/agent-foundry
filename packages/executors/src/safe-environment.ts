// Deny-by-default: only the OS/tooling variables a spawned child needs to
// start and find its own config. Never includes an application secret —
// see docs/adr/0032-app-secret-capabilities.md.
const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'NODE_ENV',
  'SystemRoot',
  'ComSpec',
  'USERPROFILE',
  'APPDATA',
]);

export function pickSafeEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => SAFE_ENV_ALLOWLIST.has(key)),
  );
}
