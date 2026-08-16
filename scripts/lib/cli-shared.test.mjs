import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..', '..');

// #562: the gate must reject BEFORE scripts/doctor.mjs spawns `codex`/`claude`,
// so we shadow both CLIs with stubs that leave a marker file behind. No marker
// means no disallowed provider process was started.
function withStubbedProviderClis(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-shared-'));
  const marker = join(dir, 'spawned.txt');
  for (const name of ['codex', 'claude']) {
    // The marker path is baked in, not passed via env: scripts/doctor.mjs
    // scrubs the probe env down to packages/executors/src/safe-env-allowlist.json.
    writeFileSync(join(dir, name), `#!/bin/sh\necho "$0" >> '${marker}'\n`, { mode: 0o755 });
  }
  try {
    return run({ dir, marker });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runTracer({ dir, campaign }) {
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    RUN_REAL_TRACER: 'true',
  };
  if (campaign === undefined) delete env.VALIDATION_CAMPAIGN;
  else env.VALIDATION_CAMPAIGN = campaign;
  return spawnSync('npx', ['tsx', 'scripts/tracer.ts', '--scenario', 'toy'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  });
}

test('real tracer refuses to start without a selected validation campaign', () => {
  withStubbedProviderClis(({ dir, marker }) => {
    const result = runTracer({ dir, campaign: undefined });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /VALIDATION_CAMPAIGN/);
    assert.equal(existsSync(marker), false, 'a provider CLI was spawned before the campaign gate');
  });
});

test('real tracer rejects an unknown campaign and names the rejected value', () => {
  withStubbedProviderClis(({ dir, marker }) => {
    const result = runTracer({ dir, campaign: 'some-other-campaign' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /VALIDATION_CAMPAIGN/);
    assert.match(result.stderr, /some-other-campaign/);
    assert.equal(existsSync(marker), false, 'a provider CLI was spawned before the campaign gate');
  });
});

test('the campaign gate runs before the doctor probes, not after them', () => {
  withStubbedProviderClis(({ dir, marker }) => {
    // Ordering, not luck: with a valid campaign the run gets past the gate and
    // reaches the doctor probes (marker written), which reject the stubs. The
    // marker also proves the stubs are wired at all, so the "no marker"
    // assertions above are not vacuously true. Pinned to the doctor's own
    // verdict rather than a non-zero exit, because a spawn timeout is also
    // non-zero — and that is the shape of "the gate let a real run start".
    const result = runTracer({ dir, campaign: 'real-todo-v1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No provider CLI is ready/);
    assert.doesNotMatch(result.stderr, /VALIDATION_CAMPAIGN/);
    assert.equal(existsSync(marker), true, 'the stub provider CLIs were never reached');
  });
});
