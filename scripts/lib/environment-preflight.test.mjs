import assert from 'node:assert/strict';
import test from 'node:test';
import { MINIMUM_FREE_BYTES, fileVaultCheck, storageChecks } from './environment-preflight.mjs';

test('blocks a forged filesystem below the 1 GiB floor and deduplicates its device', () => {
  const checks = storageChecks({
    root: '/checkout',
    dataDirectory: '/data',
    exists: () => true,
    stat: () => ({ dev: 7 }),
    statfs: () => ({ bsize: 1n, bavail: BigInt(MINIMUM_FREE_BYTES - 1) }),
  });

  assert.deepEqual(checks, [
    {
      name: 'checkout storage',
      ok: false,
      required: true,
      message: '1.0 GiB free; free at least 1 GiB and retry',
    },
  ]);
});

test('keeps FileVault unavailable as a warning, never a blocker', () => {
  assert.deepEqual(
    fileVaultCheck('linux', () => ({ status: 1 })),
    {
      name: 'FileVault',
      ok: false,
      required: false,
      warning: true,
      message: 'unavailable outside macOS; enable FileVault on the operator Mac',
    },
  );
});

test('keeps disabled macOS FileVault as a warning, never a blocker', () => {
  assert.deepEqual(
    fileVaultCheck('darwin', () => ({ status: 0, stdout: 'FileVault is Off.\n' })),
    {
      name: 'FileVault',
      ok: false,
      required: false,
      warning: true,
      message: 'unavailable or disabled; enable FileVault to protect local state',
    },
  );
});
