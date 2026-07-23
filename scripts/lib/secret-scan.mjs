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

/** Every git-tracked file, scanned for known secret shapes (no known-value list — CI doesn't have one). */
export async function scanTrackedFiles(root, knownSecrets = []) {
  const { scanForSecrets } = await loadDomain();
  const { stdout } = await run('git', ['ls-files'], { cwd: root });
  const files = stdout
    .split('\n')
    .filter(Boolean)
    .filter((file) => !EXCLUDED_TRACKED_PATH.test(file));
  const findings = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(`${root}/${file}`, 'utf8');
    } catch {
      continue; // binary or unreadable — skip rather than crash the scan
    }
    for (const match of scanForSecrets(content, knownSecrets)) {
      findings.push({ file, ...match });
    }
  }
  return findings;
}

/**
 * Every file under `dir`, scanned for known secret shapes — unlike
 * scanTrackedFiles, this walks the real filesystem regardless of Git, so it
 * catches a secret baked into build output (e.g. apps/web/.next, a "client
 * bundle") that .gitignore keeps out of scanTrackedFiles entirely. A no-op
 * if the directory doesn't exist yet (build hasn't run).
 */
export async function scanDirectoryFiles(dir, knownSecrets = []) {
  const { scanForSecrets } = await loadDomain();
  const findings = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue; // binary or unreadable — skip rather than crash the scan
    }
    for (const match of scanForSecrets(content, knownSecrets)) {
      findings.push({ file: path, ...match });
    }
  }
  return findings;
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
