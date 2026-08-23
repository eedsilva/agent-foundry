import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// A generated workspace gets this same 1 GiB tmpfs in docker-preview-installer.ts.
export const MINIMUM_FREE_BYTES = 1_024 * 1_024 * 1_024;

export function storageChecks({
  root,
  dataDirectory,
  exists = existsSync,
  stat = statSync,
  statfs = statfsSync,
}) {
  const devices = new Set();
  const checks = [];
  for (const [name, path] of [
    ['checkout storage', root],
    ['data storage', dataDirectory],
  ]) {
    const existing = existingParent(path, exists);
    try {
      const device = stat(existing).dev;
      if (devices.has(device)) continue;
      devices.add(device);
      const filesystem = statfs(existing, { bigint: true });
      const freeBytes = filesystem.bavail * filesystem.bsize;
      const ok = freeBytes >= BigInt(MINIMUM_FREE_BYTES);
      const free = formatBytes(freeBytes);
      checks.push({
        name,
        ok,
        required: true,
        message: ok ? `${free} free` : `${free} free; free at least 1 GiB and retry`,
      });
    } catch {
      checks.push({
        name,
        ok: false,
        required: true,
        message: 'could not inspect free space; check the filesystem and retry',
      });
    }
  }
  return checks;
}

export function fileVaultCheck(platform, run) {
  if (platform !== 'darwin') {
    return {
      name: 'FileVault',
      ok: false,
      required: false,
      warning: true,
      message: 'unavailable outside macOS; enable FileVault on the operator Mac',
    };
  }
  const result = run('fdesetup', ['status']);
  if (result.status === 0 && /FileVault is On\.?/i.test(combinedOutput(result))) {
    return { name: 'FileVault', ok: true, required: false, message: 'enabled' };
  }
  return {
    name: 'FileVault',
    ok: false,
    required: false,
    warning: true,
    message: 'unavailable or disabled; enable FileVault to protect local state',
  };
}

function existingParent(path, exists) {
  let current = path;
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function formatBytes(bytes) {
  return `${(Number(bytes) / 1_024 ** 3).toFixed(1)} GiB`;
}
