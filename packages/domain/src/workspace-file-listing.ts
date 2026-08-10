import ignoreFactory, { type Ignore } from 'ignore';

// The `ignore` package ships a `.d.ts` whose `export default` shape doesn't
// line up with its plain-CJS `module.exports = factory` runtime under
// TS's NodeNext resolution: `ignoreFactory` types as the module namespace
// (not callable) even though it's a callable function at runtime (verified
// directly against node_modules/ignore/index.js). Re-asserting the type
// through the declared `Ignore` interface is the documented workaround for
// this specific package, not a general escape hatch.
const ignore = ignoreFactory as unknown as (patterns?: string | string[]) => Ignore;

/**
 * Hardcoded, always applied regardless of the generated project's own
 * .gitignore content — defense in depth against a missing or broken
 * gitignore entry leaking a secret into the Files tab (#491). A separate
 * `ignore()` instance so nothing in the project's own gitignore (not even a
 * deliberate `!.env` negation) can override it.
 *
 * Not an exhaustive list of every possible credential filename — a
 * reasonable, named baseline (env files, SSH/TLS private keys, npm/AWS/netrc
 * credential files) that can grow as gaps are found.
 */
// `.env.example` alone (not `.sample`/`.template`, which have no grounding
// here) is a template file the golden-stack scaffold's own default
// .gitignore deliberately un-ignores (`!.env.example`, see
// FileWorkspaceManager.ensure() in packages/persistence) — it holds variable
// names, never real values, and hiding it would be an over-exclusion, not a
// safety win.
const ALWAYS_EXCLUDE = ignore().add([
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  '!.env.example',
  '!**/.env.example',
  // SSH/TLS private keys.
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa',
  '**/id_ed25519',
  '**/id_ecdsa',
  '**/id_dsa',
  '.ssh/**',
  '**/.ssh/**',
  // Tool/cloud credential files.
  '.npmrc',
  '**/.npmrc',
  '.netrc',
  '**/.netrc',
  '.aws/credentials',
  '**/.aws/credentials',
]);

/**
 * Narrows a workspace's file list down to what's safe/appropriate to show in
 * the read-only Files tab: respects the project's own .gitignore, then
 * applies the hardcoded always-exclude on top, unconditionally.
 */
export function filterListablePaths(paths: string[], gitignoreContent: string): string[] {
  const projectIgnore = ignore().add(gitignoreContent);
  return ALWAYS_EXCLUDE.filter(projectIgnore.filter(paths));
}
