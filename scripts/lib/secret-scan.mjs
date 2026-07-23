import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

let domain;
async function loadDomain() {
  if (domain) return domain;
  try {
    domain = await import('@agent-foundry/domain');
  } catch (error) {
    console.error('Could not load @agent-foundry/domain. Run `npm run build` first.');
    throw error;
  }
  return domain;
}

// ponytail: pattern-only scanning (no known-value list at CI time) is
// inherently prone to false positives on the fake secret-shaped fixtures
// this repo's own tests use deliberately (e.g. redaction.test.ts, this
// task's own secret-scan.test.mjs). A per-string allowlist would avoid
// excluding whole files, but needs a maintained baseline — out of scope
// for personal v1. Skip test/doc/example paths instead: source that could
// actually ship (app code, build output scanned separately by
// scanDirectoryFiles) is still fully covered. Upgrade path: gitleaks-style
// baseline file if false positives outside these paths become a problem.
const EXCLUDED_TRACKED_PATH = /(?:^(docs|examples)\/|\.(test|spec)\.(ts|tsx|js|mjs)$)/;

// Reads and scans each file concurrently (independent I/O per file), keeping
// scanTrackedFiles/scanDirectoryFiles down to "how do I list the files."
async function scanFileList(files, knownSecrets) {
  const { scanForSecrets } = await loadDomain();
  const perFile = await Promise.all(
    files.map(async ({ path, label }) => {
      let content;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        return []; // binary or unreadable — skip rather than crash the scan
      }
      return scanForSecrets(content, knownSecrets).map((match) => ({ file: label, ...match }));
    }),
  );
  return perFile.flat();
}

/** Every git-tracked file, scanned for known secret shapes (no known-value list — CI doesn't have one). */
export async function scanTrackedFiles(root, knownSecrets = []) {
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const files = stdout
    .split('\n')
    .filter(Boolean)
    .filter((file) => !EXCLUDED_TRACKED_PATH.test(file))
    .map((file) => ({ path: `${root}/${file}`, label: file }));
  return scanFileList(files, knownSecrets);
}

/**
 * Every file under `dir`, scanned for known secret shapes — unlike
 * scanTrackedFiles, this walks the real filesystem regardless of Git, so it
 * catches a secret baked into build output (e.g. apps/web/.next, a "client
 * bundle") that .gitignore keeps out of scanTrackedFiles entirely. A no-op
 * if the directory doesn't exist yet (build hasn't run).
 */
export async function scanDirectoryFiles(dir, knownSecrets = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath ?? entry.path, entry.name);
      return { path, label: path };
    });
  return scanFileList(files, knownSecrets);
}

/** Fails if any real .env file (anything but .env.example) is git-tracked. */
export async function assertNoRealEnvFilesTracked(root) {
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const tracked = stdout.split('\n').filter(Boolean);
  const offenders = tracked.filter(
    (file) => /(^|\/)\.env(\..+)?$/.test(file) && !file.endsWith('.env.example'),
  );
  if (offenders.length > 0) {
    throw new Error(`.env is tracked by Git: ${offenders.join(', ')}`);
  }
}
