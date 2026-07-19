import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Resolves a candidate file path (untrusted — e.g. reported by an
 * instrumented preview iframe) against a project's workspace root, returning
 * the workspace-relative path if it stays inside the workspace, or null if it
 * escapes (absolute outside the root, `..` traversal) or resolves to the
 * workspace root itself. Mirrors sandbox-runner.ts's isAllowed containment
 * check but on real host paths, since candidatePath may itself be absolute.
 */
export function resolveWorkspaceRelativePath(
  workspaceRoot: string,
  candidatePath: string,
): string | null {
  const absoluteRoot = resolve(workspaceRoot);
  const absoluteCandidate = resolve(absoluteRoot, candidatePath);
  const rel = relative(absoluteRoot, absoluteCandidate);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel;
}
