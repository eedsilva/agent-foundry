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
// A slash-free pattern (or one with only a trailing slash) already matches
// at every depth in gitignore semantics — `.env` matches `sub/dir/.env`
// unaided. Only a pattern with a slash *in the middle* (`.aws/credentials`,
// `.ssh/**`) is anchored to that exact path and needs an explicit `**/`
// sibling to also match nested. Verified against the `ignore` package
// directly, not assumed — don't re-add a blanket `**/` pass "to be safe".
const ALWAYS_EXCLUDE = ignore().add([
  // VCS internals. `.git/objects` alone can hold thousands of raw blobs, and
  // nobody lists `.git` in their own .gitignore — git already never tracks
  // itself — so nothing else here would ever prune it.
  '.git',
  '.env',
  '.env.*',
  '!.env.example',
  // SSH/TLS private keys.
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
  '.ssh/**',
  '**/.ssh/**',
  // Tool/cloud credential files.
  '.npmrc',
  '.netrc',
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

export interface WorkspaceListabilityChecker {
  /** True when a directory (and everything under it) should be skipped
   * without descending — lets a caller prune node_modules/.next/dist/etc.
   * during its own traversal instead of walking them and discarding the
   * result afterward. */
  isDirectoryPrunable(relativeDirPath: string): boolean;
  isFileListable(relativePath: string): boolean;
}

/**
 * Builds the gitignore matcher once so a directory walk can query it
 * per-entry without re-parsing the project's .gitignore on every call —
 * the tree-walking counterpart to filterListablePaths' flat-list shape.
 */
export function createListabilityChecker(gitignoreContent: string): WorkspaceListabilityChecker {
  const projectIgnore = ignore().add(gitignoreContent);
  return {
    isDirectoryPrunable: (relativeDirPath) =>
      projectIgnore.ignores(`${relativeDirPath}/`) || ALWAYS_EXCLUDE.ignores(`${relativeDirPath}/`),
    isFileListable: (relativePath) =>
      !projectIgnore.ignores(relativePath) && !ALWAYS_EXCLUDE.ignores(relativePath),
  };
}
