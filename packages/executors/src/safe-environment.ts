// Deny-by-default: only the OS/tooling variables a spawned child needs to
// start and find its own config. Never includes an application secret —
// see docs/adr/0033-app-secret-capabilities.md.
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

export function pickSafeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => SAFE_ENV_ALLOWLIST.has(key)));
}

/**
 * The full execa option fragment for spawning untrusted code with a scoped
 * environment: the safe allowlist plus explicit overrides, with `extendEnv`
 * hardcoded to `false`. execa defaults `extendEnv: true`, which re-merges the
 * full `process.env` underneath any explicit `env` option — silently undoing
 * the allowlist for every key the scoped object doesn't itself override.
 * Bundling both here means a spawn point gets this protection by construction
 * instead of by remembering to copy both the `env:` line and the flag.
 */
export function safeSpawnEnv(
  source: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
): { env: NodeJS.ProcessEnv; extendEnv: false } {
  return {
    env: Object.fromEntries(
      Object.entries({ ...pickSafeEnvironment(source), ...overrides }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    extendEnv: false,
  };
}
