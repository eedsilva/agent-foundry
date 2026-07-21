# Docker Sandbox Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `DockerSandboxRunner`, the first real backend for the `SandboxRunner` contract from ADR-0024 (issue #46), satisfying issue #47's rootless-container acceptance criteria: non-root user, no privileged mode, minimal capabilities, read-only rootfs except a size-bounded workspace/tmp, CPU/memory/pids/disk ceilings, a digest-pinned base image with a generated SBOM, and a guarantee the host Docker socket is never mounted into a sandbox.

**Architecture:** `DockerSandboxRunner` (in `packages/executors`) shells out to the `docker` CLI via `execa` (already a dependency), mirroring the existing `BaseCliExecutor` subprocess conventions. `create()` runs `docker create`/`docker start` with hardening flags computed by a pure, unit-tested `buildCreateArgs(spec)` function. `exec()` runs `docker exec` with streaming, timeout, and `AbortSignal` support matching `RunCancelledError` conventions used elsewhere in this codebase. `snapshot()` uses `docker exec ... tar -cf -` piped into a host `tar -xf -` (verified empirically below — `docker cp` cannot read tmpfs-backed paths on this Docker Desktop install, so snapshot must go through a live `tar` stream instead). `destroy()` runs `docker rm -f`, tolerating "no such container" for idempotency. The workspace and `/tmp` are tmpfs mounts (RAM-backed, size-capped) rather than host bind mounts: because the root filesystem is `--read-only`, there is no container writable layer left to separately disk-quota — every writable byte lives in a `size=`-bounded tmpfs, which is what actually enforces the disk ceiling portably (`--storage-opt size=` is NOT portable — verified below, it errors on this machine's overlay2 driver, and ubuntu-latest GitHub runners are in the same boat).

This backend is **not** wired into `packages/composition`'s runtime graph or the orchestrator's `ExecutionPlane` in this plan. Nothing in the codebase constructs a `SandboxSpec` yet (`LocalExecutionPlane` remains the active path per ADR-0024), and `packages/composition` has no config surface that would consume a sandbox image reference today. Wiring `DockerSandboxRunner` in as the default execution path is explicitly out of scope for #47 in the roadmap (`v07-network-policy` and `v07-secret-broker` are separate, dependent roadmap items) — adding unused composition config now would be speculative. This is recorded as a deliberate scope boundary in the new ADR (Task 6).

**Tech Stack:** TypeScript, `execa` (already an `@agent-foundry/executors` dependency), Docker CLI (`create`/`start`/`exec`/`rm`, plus host `tar` for snapshot extraction — no new npm dependency), Vitest.

## Global Constraints

- Sandbox image reference passed to `create()` must contain `@sha256:` (digest pin) — `create()` throws otherwise.
- No `spec.mounts` entry may reference `docker.sock` (source or target) — `create()` throws otherwise.
- No `spec.mounts` entry may target `/workspace` or `/tmp` — those paths are reserved for the runner's own size-capped tmpfs mounts — `create()` throws otherwise.
- Never pass `--privileged`. Always pass `--cap-drop=ALL` (no `--cap-add`) and `--security-opt=no-new-privileges`.
- `destroy()` must be safe to call repeatedly for the same handle (matches the `SandboxRunner` interface's documented contract).
- All new integration tests that require a running Docker daemon must be gated with `describe.skipIf` so `npm test` still passes on machines without Docker, while running for real on `ubuntu-latest` in CI (Docker Engine is preinstalled there).
- Pinned base image for this plan's tests and default reference: `node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3` (resolved from `node:22-bookworm-slim` on 2026-07-20 — the digest this plan's commands were verified against).

---

## File Structure

- Create: `packages/executors/src/docker-sandbox-runner.ts` — `buildCreateArgs`, validators, `DockerSandboxRunner` class (`create`/`exec`/`snapshot`/`destroy`).
- Create: `packages/executors/src/docker-sandbox-runner.test.ts` — pure unit tests for `buildCreateArgs` and the validators (no Docker daemon required).
- Create: `packages/executors/src/docker-sandbox-runner.integration.test.ts` — real-Docker behavioral tests (user, read-only rootfs, capabilities, resource limits, network isolation, mounts, snapshot, destroy idempotency) plus an end-to-end `runSandboxLifecycle` proof.
- Modify: `packages/executors/src/index.ts` — export the new module.
- Create: `docs/sbom/sandbox-image.spdx.json` — generated SBOM evidence for the pinned base image.
- Modify: `.github/workflows/ci.yml` — add a `sandbox-sbom` job generating the SBOM on every CI run.
- Create: `docs/adr/0025-docker-sandbox-runner.md` — decision record, including the scope boundary explained above.
- Modify: `docs/SECURITY.md` — update the "Isolamento de processo" section to reflect the backend now existing.
- Modify: `docs/ARCHITECTURE.md` — note `DockerSandboxRunner` as the first `SandboxRunner` implementation.

---

### Task 1: Pure argument-building and validation

**Files:**

- Create: `packages/executors/src/docker-sandbox-runner.ts`
- Test: `packages/executors/src/docker-sandbox-runner.test.ts`

**Interfaces:**

- Consumes: `SandboxSpec`, `SandboxMount` from `@agent-foundry/contracts` (already defined in `packages/contracts/src/sandbox.ts`).
- Produces: `SANDBOX_WORKSPACE_PATH: string`, `SANDBOX_TMP_SIZE_MIB: number`, `buildCreateArgs(spec: SandboxSpec): string[]` — consumed by Task 2's `create()`.

- [ ] **Step 1: Write the failing tests**

Create `packages/executors/src/docker-sandbox-runner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import {
  buildCreateArgs,
  SANDBOX_TMP_SIZE_MIB,
  SANDBOX_WORKSPACE_PATH,
} from './docker-sandbox-runner.js';

const PINNED_IMAGE = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: PINNED_IMAGE,
    resources: { cpuMillis: 500, memoryMiB: 512, diskMiB: 256, pids: 64 },
    network: { mode: 'none', allowedHosts: [] },
    mounts: [],
    ttlMs: 60_000,
    user: '1000:1000',
    ...overrides,
  };
}

describe('buildCreateArgs', () => {
  it('builds a hardened docker create invocation', () => {
    const args = buildCreateArgs(spec());
    expect(args).toEqual([
      'create',
      '--user',
      '1000:1000',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--memory=512m',
      '--memory-swap=512m',
      '--cpus=0.500',
      '--network=none',
      `--tmpfs=${SANDBOX_WORKSPACE_PATH}:rw,nosuid,nodev,size=256m,mode=1777`,
      `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${SANDBOX_TMP_SIZE_MIB}m,mode=1777`,
      PINNED_IMAGE,
      'sleep',
      'infinity',
    ]);
  });

  it('never emits --privileged and always drops all capabilities', () => {
    const args = buildCreateArgs(spec());
    expect(args).not.toContain('--privileged');
    expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('--security-opt=no-new-privileges');
  });

  it('maps network mode allowlist to the bridge network', () => {
    const args = buildCreateArgs(
      spec({ network: { mode: 'allowlist', allowedHosts: ['example.com'] } }),
    );
    expect(args).toContain('--network=bridge');
  });

  it('appends -v flags for each mount, honoring readOnly', () => {
    const args = buildCreateArgs(
      spec({
        mounts: [
          { source: '/host/cache', target: '/mnt/cache', readOnly: true },
          { source: '/host/scratch', target: '/mnt/scratch', readOnly: false },
        ],
      }),
    );
    expect(args).toContain('-v');
    expect(args).toContain('/host/cache:/mnt/cache:ro');
    expect(args).toContain('/host/scratch:/mnt/scratch');
    expect(args).not.toContain('/host/scratch:/mnt/scratch:ro');
  });

  it('rejects an image that is not pinned by digest', () => {
    expect(() => buildCreateArgs(spec({ image: 'node:22-bookworm-slim' }))).toThrow(
      /pinned by digest/,
    );
  });

  it('rejects a mount referencing the host Docker socket', () => {
    expect(() =>
      buildCreateArgs(
        spec({
          mounts: [
            { source: '/var/run/docker.sock', target: '/var/run/docker.sock', readOnly: false },
          ],
        }),
      ),
    ).toThrow(/Docker socket/);
  });

  it('rejects a mount targeting the reserved workspace path', () => {
    expect(() =>
      buildCreateArgs(
        spec({ mounts: [{ source: '/host/x', target: SANDBOX_WORKSPACE_PATH, readOnly: false }] }),
      ),
    ).toThrow(/reserved/);
  });

  it('rejects a mount targeting the reserved tmp path', () => {
    expect(() =>
      buildCreateArgs(spec({ mounts: [{ source: '/host/x', target: '/tmp', readOnly: false }] })),
    ).toThrow(/reserved/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.test.ts`
Expected: FAIL — `Cannot find module './docker-sandbox-runner.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/executors/src/docker-sandbox-runner.ts`:

```ts
import type { SandboxSpec } from '@agent-foundry/contracts';

export const SANDBOX_WORKSPACE_PATH = '/workspace';
export const SANDBOX_TMP_SIZE_MIB = 64;

const RESERVED_MOUNT_TARGETS = new Set([SANDBOX_WORKSPACE_PATH, '/tmp']);

function assertDigestPinned(spec: SandboxSpec): void {
  if (!spec.image.includes('@sha256:')) {
    throw new Error(`Sandbox image must be pinned by digest (got "${spec.image}").`);
  }
}

function assertMountsAreSafe(spec: SandboxSpec): void {
  for (const mount of spec.mounts) {
    if (mount.source.includes('docker.sock') || mount.target.includes('docker.sock')) {
      throw new Error('Sandbox mounts must never reference the host Docker socket.');
    }
    if (RESERVED_MOUNT_TARGETS.has(mount.target)) {
      throw new Error(
        `Sandbox mount target "${mount.target}" is reserved for the runner's own tmpfs.`,
      );
    }
  }
}

/** Pure: computes the `docker create` argv for a spec. No side effects, no I/O. */
export function buildCreateArgs(spec: SandboxSpec): string[] {
  assertDigestPinned(spec);
  assertMountsAreSafe(spec);

  const args = [
    'create',
    '--user',
    spec.user,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--pids-limit=${String(spec.resources.pids)}`,
    `--memory=${String(spec.resources.memoryMiB)}m`,
    `--memory-swap=${String(spec.resources.memoryMiB)}m`,
    `--cpus=${(spec.resources.cpuMillis / 1000).toFixed(3)}`,
    `--network=${spec.network.mode === 'none' ? 'none' : 'bridge'}`,
    `--tmpfs=${SANDBOX_WORKSPACE_PATH}:rw,nosuid,nodev,size=${String(spec.resources.diskMiB)}m,mode=1777`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${String(SANDBOX_TMP_SIZE_MIB)}m,mode=1777`,
  ];
  for (const mount of spec.mounts) {
    args.push('-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
  }
  args.push(spec.image, 'sleep', 'infinity');
  return args;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/docker-sandbox-runner.ts packages/executors/src/docker-sandbox-runner.test.ts
git commit -m "feat(executors): build hardened docker create args for the sandbox runner"
```

---

### Task 2: `DockerSandboxRunner.create` / `destroy`

**Files:**

- Modify: `packages/executors/src/docker-sandbox-runner.ts`
- Create: `packages/executors/src/docker-sandbox-runner.integration.test.ts`

**Interfaces:**

- Consumes: `buildCreateArgs` (Task 1); `SandboxHandle`, `SandboxRunner` from `@agent-foundry/domain`.
- Produces: `class DockerSandboxRunner implements SandboxRunner` with `create(spec): Promise<SandboxHandle>` and `destroy(sandbox): Promise<void>` — Tasks 3 and 4 add `exec`/`snapshot` to this same class.

- [ ] **Step 1: Write the failing test**

Create `packages/executors/src/docker-sandbox-runner.integration.test.ts`:

```ts
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { DockerSandboxRunner, SANDBOX_WORKSPACE_PATH } from './docker-sandbox-runner.js';

const PINNED_IMAGE = 'node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3';

async function dockerAvailable(): Promise<boolean> {
  try {
    await execa('docker', ['version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerAvailable();

function spec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    image: PINNED_IMAGE,
    resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 32 },
    network: { mode: 'none', allowedHosts: [] },
    mounts: [],
    ttlMs: 60_000,
    user: '1000:1000',
    ...overrides,
  };
}

describe.skipIf(!hasDocker)(
  'DockerSandboxRunner (integration)',
  () => {
    const runner = new DockerSandboxRunner();
    const created: string[] = [];

    afterEach(async () => {
      while (created.length > 0) {
        const id = created.pop();
        if (id) await execa('docker', ['rm', '-f', id], { reject: false });
      }
    });

    it('creates a running container matching the hardening flags', async () => {
      const handle = await runner.create(spec());
      created.push(handle.id);

      const inspect = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{.State.Running}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.NetworkMode}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}',
      ]);
      expect(inspect.stdout.trim()).toBe('true 134217728 500000000 32 none true false');

      const capDrop = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{json .HostConfig.CapDrop}}',
      ]);
      expect(JSON.parse(capDrop.stdout)).toEqual(['ALL']);

      const tmpfs = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{json .HostConfig.Tmpfs}}',
      ]);
      expect(JSON.parse(tmpfs.stdout)).toEqual({
        [SANDBOX_WORKSPACE_PATH]: 'rw,nosuid,nodev,size=64m,mode=1777',
        '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
      });

      await runner.destroy(handle);
      created.pop();
    });

    it('destroy is idempotent for the same handle', async () => {
      const handle = await runner.create(spec());
      await runner.destroy(handle);
      await expect(runner.destroy(handle)).resolves.toBeUndefined();
    });

    it('rejects a spec with an unpinned image before touching Docker', async () => {
      await expect(runner.create(spec({ image: 'node:22-bookworm-slim' }))).rejects.toThrow(
        /pinned by digest/,
      );
    });
  },
  60_000,
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: FAIL — `DockerSandboxRunner` is not exported.

- [ ] **Step 3: Implement `create` and `destroy`**

Append to `packages/executors/src/docker-sandbox-runner.ts` (add these imports at the top and the class at the bottom):

```ts
import { execa } from 'execa';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
```

```ts
export class DockerSandboxRunner implements SandboxRunner {
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const args = buildCreateArgs(spec);
    const created = await execa('docker', args, { reject: false });
    if (created.exitCode !== 0) {
      throw new Error(`docker create failed: ${created.stderr || created.stdout}`);
    }
    const id = created.stdout.trim();
    const started = await execa('docker', ['start', id], { reject: false });
    if (started.exitCode !== 0) {
      await execa('docker', ['rm', '-f', id], { reject: false });
      throw new Error(`docker start failed: ${started.stderr || started.stdout}`);
    }
    return { id };
  }

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const result = await execa('docker', ['rm', '-f', sandbox.id], { reject: false });
    if (result.exitCode !== 0 && !/No such container/.test(result.stderr ?? '')) {
      throw new Error(`docker rm failed: ${result.stderr || result.stdout}`);
    }
  }
}
```

Note: `create()` calls `buildCreateArgs(spec)` first, which throws synchronously on an unpinned image or unsafe mount _before_ any `execa` call — so the "rejects a spec with an unpinned image" test never touches Docker, matching its name.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: PASS (3 tests). If Docker is not running locally, expect `3 skipped` instead — that is also a pass.

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/docker-sandbox-runner.ts packages/executors/src/docker-sandbox-runner.integration.test.ts
git commit -m "feat(executors): implement DockerSandboxRunner create/destroy"
```

---

### Task 3: `DockerSandboxRunner.exec` and behavioral security proofs

**Files:**

- Modify: `packages/executors/src/docker-sandbox-runner.ts`
- Modify: `packages/executors/src/docker-sandbox-runner.integration.test.ts`

**Interfaces:**

- Consumes: `RunCancelledError`, `errorMessage` from `@agent-foundry/domain`; `SandboxExecRequest`, `SandboxExecResult` from `@agent-foundry/domain`.
- Produces: `exec(sandbox, request, signal?): Promise<SandboxExecResult>` on `DockerSandboxRunner` — Task 5's end-to-end test drives this through `runSandboxLifecycle`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/executors/src/docker-sandbox-runner.integration.test.ts` (inside the existing `describe.skipIf` block, after the `create`/`destroy` tests):

```ts
it('runs as the configured non-root user', async () => {
  const handle = await runner.create(spec({ user: '1000:1000' }));
  created.push(handle.id);
  const result = await runner.exec(handle, { command: 'id', args: ['-u'], timeoutMs: 5_000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('1000');
});

it('has an all-zero effective capability set', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const result = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'grep CapEff /proc/self/status'],
    timeoutMs: 5_000,
  });
  expect(result.stdout.trim()).toBe('CapEff:\t0000000000000000');
});

it('rejects writes outside the workspace and tmp on the read-only rootfs', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const result = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'touch /etc/should-fail'],
    timeoutMs: 5_000,
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toMatch(/Read-only file system/);
});

it('allows writes inside the workspace tmpfs', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const result = await runner.exec(handle, {
    command: 'sh',
    args: [
      '-c',
      `echo hello > ${SANDBOX_WORKSPACE_PATH}/ok.txt && cat ${SANDBOX_WORKSPACE_PATH}/ok.txt`,
    ],
    timeoutMs: 5_000,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe('hello');
});

it('enforces the pids limit', async () => {
  const handle = await runner.create(
    spec({ resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 4 } }),
  );
  created.push(handle.id);
  // Verified by hand: execing immediately after create/start races the container's own
  // startup and can fail with an unrelated "procReady not received" OCI error instead of
  // exercising the pids limit. A short settle delay makes the "Cannot fork" failure — the
  // actual behavior under test — reproduce consistently across three manual trials.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do sleep 5 & done; wait'],
    timeoutMs: 5_000,
  });
  expect(result.exitCode).not.toBe(0);
});

it('has no network route when network mode is none', async () => {
  const handle = await runner.create(spec({ network: { mode: 'none', allowedHosts: [] } }));
  created.push(handle.id);
  const result = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'cat /proc/net/route | wc -l'],
    timeoutMs: 5_000,
  });
  expect(result.stdout.trim()).toBe('1'); // header row only, no routes
});

it('has a default route when network mode is allowlist', async () => {
  const handle = await runner.create(
    spec({ network: { mode: 'allowlist', allowedHosts: ['example.com'] } }),
  );
  created.push(handle.id);
  const result = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'cat /proc/net/route | wc -l'],
    timeoutMs: 5_000,
  });
  expect(Number(result.stdout.trim())).toBeGreaterThan(1);
});

it('honors a read-only bind mount', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const hostDir = await mkdtemp(join(tmpdir(), 'sandbox-mount-'));
  await writeFile(join(hostDir, 'seed.txt'), 'seed');

  const handle = await runner.create(
    spec({ mounts: [{ source: hostDir, target: '/mnt/cache', readOnly: true }] }),
  );
  created.push(handle.id);

  const read = await runner.exec(handle, {
    command: 'cat',
    args: ['/mnt/cache/seed.txt'],
    timeoutMs: 5_000,
  });
  expect(read.stdout.trim()).toBe('seed');

  const write = await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'echo x > /mnt/cache/new.txt'],
    timeoutMs: 5_000,
  });
  expect(write.exitCode).not.toBe(0);
  expect(write.stderr).toMatch(/Read-only file system/);
});

it('streams stdout and stderr chunks via onOutput', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const chunks: Array<{ stream: string; text: string }> = [];
  await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'echo out-line; echo err-line >&2'],
    timeoutMs: 5_000,
    onOutput: (chunk) => chunks.push(chunk),
  });
  expect(chunks.some((c) => c.stream === 'stdout' && c.text.includes('out-line'))).toBe(true);
  expect(chunks.some((c) => c.stream === 'stderr' && c.text.includes('err-line'))).toBe(true);
});

it('throws when the command exceeds its timeout', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  await expect(
    runner.exec(handle, { command: 'sleep', args: ['5'], timeoutMs: 300 }),
  ).rejects.toThrow(/timeout/);
});

it('throws RunCancelledError when the signal is already aborted', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const controller = new AbortController();
  controller.abort();
  await expect(
    runner.exec(handle, { command: 'sleep', args: ['1'], timeoutMs: 5_000 }, controller.signal),
  ).rejects.toThrow(/cancelled/);
});

it('throws RunCancelledError when aborted mid-execution', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await expect(
    runner.exec(handle, { command: 'sleep', args: ['5'], timeoutMs: 10_000 }, controller.signal),
  ).rejects.toThrow(/cancelled/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: FAIL — `runner.exec is not a function`.

- [ ] **Step 3: Implement `exec`**

Add these imports to the top of `packages/executors/src/docker-sandbox-runner.ts`:

```ts
import {
  RunCancelledError,
  errorMessage,
  type SandboxExecRequest,
  type SandboxExecResult,
} from '@agent-foundry/domain';
```

Add this method inside the `DockerSandboxRunner` class (after `create`, before `destroy`):

```ts
  async exec(
    sandbox: SandboxHandle,
    request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult> {
    if (signal?.aborted) throw new RunCancelledError();

    const subprocess = execa(
      'docker',
      ['exec', '-w', SANDBOX_WORKSPACE_PATH, sandbox.id, request.command, ...request.args],
      { timeout: request.timeoutMs, reject: false, all: false, encoding: 'utf8' },
    );

    if (request.onOutput) {
      subprocess.stdout?.on('data', (chunk: Buffer | string) => {
        request.onOutput?.({ stream: 'stdout', text: chunk.toString() });
      });
      subprocess.stderr?.on('data', (chunk: Buffer | string) => {
        request.onOutput?.({ stream: 'stderr', text: chunk.toString() });
      });
    }

    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => subprocess.kill('SIGKILL');
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const result = await subprocess;
      if (signal?.aborted) throw new RunCancelledError();
      if (result.timedOut) {
        throw new Error(`Sandbox exec exceeded its ${String(request.timeoutMs)}ms timeout.`);
      }
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      if (signal?.aborted) throw new RunCancelledError();
      if (error instanceof Error) throw error;
      throw new Error(errorMessage(error));
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: PASS (all tests so far). This step is the direct evidence for issue #47's "Verificar limites, usuário, mounts e tentativa de acesso ao host" test requirement — capture this output for the PR description.

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/docker-sandbox-runner.ts packages/executors/src/docker-sandbox-runner.integration.test.ts
git commit -m "feat(executors): implement DockerSandboxRunner exec with streaming, timeout, and cancellation"
```

---

### Task 4: `DockerSandboxRunner.snapshot`

**Files:**

- Modify: `packages/executors/src/docker-sandbox-runner.ts`
- Modify: `packages/executors/src/docker-sandbox-runner.integration.test.ts`

**Interfaces:**

- Consumes: `SandboxSnapshot`, `SandboxSnapshotFile` from `@agent-foundry/contracts`.
- Produces: `snapshot(sandbox, allowedPaths): Promise<SandboxSnapshot>` on `DockerSandboxRunner` — completes the `SandboxRunner` interface, consumed by Task 5's `runSandboxLifecycle` test.

**Verified constraint:** `docker cp` cannot read a tmpfs-mounted path on this Docker Desktop install (confirmed by hand: writing a file to a tmpfs `/workspace` and then running `docker cp <id>:/workspace/out.txt .` fails with "Could not find the file", even though `docker exec <id> cat /workspace/out.txt` reads it fine). `docker exec <id> tar -cf - -C /workspace <path> | tar -xf - -C <hostDir>` does work, because it reads through a live process instead of Docker's copy-out API. Use that.

- [ ] **Step 1: Write the failing tests**

Add to `packages/executors/src/docker-sandbox-runner.integration.test.ts` (inside the `describe.skipIf` block):

```ts
it('extracts allowed files and directories from the workspace', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  await runner.exec(handle, {
    command: 'sh',
    args: ['-c', 'echo hello > out.txt && mkdir sub && echo nested > sub/n.txt'],
    timeoutMs: 5_000,
  });

  const snapshot = await runner.snapshot(handle, ['out.txt', 'sub']);
  const byPath = Object.fromEntries(
    snapshot.files.map((file) => [file.path, Buffer.from(file.content).toString('utf8').trim()]),
  );
  expect(byPath['out.txt']).toBe('hello');
  expect(byPath['sub/n.txt']).toBe('nested');
});

it('silently skips an allowed path that does not exist', async () => {
  const handle = await runner.create(spec());
  created.push(handle.id);
  const snapshot = await runner.snapshot(handle, ['does-not-exist']);
  expect(snapshot.files).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: FAIL — `runner.snapshot is not a function`.

- [ ] **Step 3: Implement `snapshot`**

Add these imports to the top of `packages/executors/src/docker-sandbox-runner.ts`:

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { SandboxSnapshot, SandboxSnapshotFile } from '@agent-foundry/contracts';
```

Add this method inside the `DockerSandboxRunner` class (after `exec`, before `destroy`):

```ts
  async snapshot(sandbox: SandboxHandle, allowedPaths: readonly string[]): Promise<SandboxSnapshot> {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-foundry-sandbox-'));
    try {
      for (const relativePath of allowedPaths) {
        const tarResult = await execa(
          'docker',
          ['exec', sandbox.id, 'tar', '-cf', '-', '-C', SANDBOX_WORKSPACE_PATH, relativePath],
          { reject: false, encoding: 'buffer' },
        );
        if (tarResult.exitCode !== 0) continue; // path does not exist in the sandbox — nothing to export
        await execa('tar', ['-xf', '-', '-C', tempDir], { input: tarResult.stdout, reject: false });
      }
      return { files: await collectFiles(tempDir, tempDir) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
```

Add this standalone helper function at the bottom of the file (outside the class):

```ts
async function collectFiles(root: string, dir: string): Promise<SandboxSnapshotFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SandboxSnapshotFile[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath)));
    } else if (entry.isFile()) {
      const content = await readFile(fullPath);
      files.push({
        path: relative(root, fullPath).split(sep).join('/'),
        content: new Uint8Array(content),
      });
    }
  }
  return files;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/docker-sandbox-runner.ts packages/executors/src/docker-sandbox-runner.integration.test.ts
git commit -m "feat(executors): implement DockerSandboxRunner snapshot via docker exec tar streaming"
```

---

### Task 5: Export and end-to-end `runSandboxLifecycle` proof

**Files:**

- Modify: `packages/executors/src/index.ts`
- Modify: `packages/executors/src/docker-sandbox-runner.integration.test.ts`

**Interfaces:**

- Consumes: `runSandboxLifecycle` from `@agent-foundry/domain` (already exists, defined in `packages/domain/src/sandbox-runner.ts`); the completed `DockerSandboxRunner` from Tasks 1-4.
- Produces: nothing new for later tasks — this is the capstone integration proof and the public export.

- [ ] **Step 1: Add the export**

Modify `packages/executors/src/index.ts` — add this line (alphabetically it can go after the `local-execution-plane` export):

```ts
export * from './docker-sandbox-runner.js';
```

- [ ] **Step 2: Write the end-to-end test**

Add to `packages/executors/src/docker-sandbox-runner.integration.test.ts`. First, add this import at the top of the file alongside the others:

```ts
import { runSandboxLifecycle } from '@agent-foundry/domain';
```

Then add this test inside the `describe.skipIf` block. It does not push anything onto `created`
because `runSandboxLifecycle`'s own `finally` already calls `destroy()` on the sandbox it creates —
that is the exact behavior this test proves:

```ts
it('runs the full runSandboxLifecycle contract against a real container', async () => {
  const { result, snapshot } = await runSandboxLifecycle(
    runner,
    spec(),
    {
      command: 'sh',
      args: ['-c', 'echo hi > report.txt && mkdir secrets && echo s > secrets/.env'],
      timeoutMs: 5_000,
    },
    ['report.txt'],
  );
  expect(result.exitCode).toBe(0);
  expect(snapshot.files.map((f) => f.path)).toEqual(['report.txt']);
});
```

- [ ] **Step 3: Run the full integration suite**

Run: `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts`
Expected: PASS (all tests, including the new end-to-end one). This is the primary evidence artifact for the PR: it proves ADR-0024's full `create → exec → snapshot allowlist-filtering → destroy` contract against a real, hardened container.

- [ ] **Step 4: Run the whole package test suite to check for regressions**

Run: `npx vitest run packages/executors`
Expected: PASS, no regressions in existing executor tests.

- [ ] **Step 5: Commit**

```bash
git add packages/executors/src/index.ts packages/executors/src/docker-sandbox-runner.integration.test.ts
git commit -m "feat(executors): export DockerSandboxRunner and prove the full sandbox lifecycle end to end"
```

---

### Task 6: SBOM evidence, CI job, ADR, and docs

**Files:**

- Create: `docs/sbom/sandbox-image.spdx.json`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/adr/0025-docker-sandbox-runner.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARCHITECTURE.md`

**Interfaces:**

- Consumes: nothing from earlier tasks (this task is documentation and CI evidence only).
- Produces: nothing consumed by later tasks — this is the final task.

- [ ] **Step 1: Generate the SBOM evidence file locally**

Run (requires the `docker sbom` plugin — bundled with Docker Desktop; if unavailable, skip this local step and rely on the CI job in Step 2 for the actual enforced evidence):

```bash
mkdir -p docs/sbom
docker sbom node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 \
  --format spdx-json --output docs/sbom/sandbox-image.spdx.json
```

Expected: `docs/sbom/sandbox-image.spdx.json` is created and contains a `"spdxVersion"` key. If this local step is not possible, Step 2's CI job produces the equivalent evidence as a downloadable workflow artifact on every run, and `docs/sbom/sandbox-image.spdx.json` can be committed later as a manual copy of that artifact.

- [ ] **Step 2: Add a CI job that regenerates and uploads the SBOM on every run**

Modify `.github/workflows/ci.yml` — add this job after the `build` job (which ends at the `run: npm run build` line):

```yaml
sandbox-sbom:
  name: sandbox-sbom
  needs: preflight
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v7
    - name: Pull the pinned sandbox base image
      run: docker pull node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
    - name: Generate SBOM
      uses: anchore/sbom-action@v0
      with:
        image: node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3
        format: spdx-json
        output-file: sandbox-image.spdx.json
    - uses: actions/upload-artifact@v4
      with:
        name: sandbox-image-sbom
        path: sandbox-image.spdx.json
        retention-days: 90
```

- [ ] **Step 3: Write the ADR**

Create `docs/adr/0025-docker-sandbox-runner.md`:

````markdown
# ADR 0025: Docker sandbox runner backend

- Status: Accepted
- Date: 2026-07-20
- Owners: Safety and Executors

## Context

ADR-0024 (issue #46) defined the `SandboxRunner` lifecycle contract but deliberately shipped no
backend — `LocalExecutionPlane` remained the only trusted path, running agent CLIs in-process with
full host permissions. Issue #47 requires a rootless container backend: non-root user, no
`--privileged`, minimal capabilities, a read-only root filesystem except a bounded workspace and
tmpfs, CPU/memory/pids/disk ceilings, a digest-pinned base image with a generated SBOM, and a
guarantee the host Docker socket is never mounted into a sandbox.

## Decision

`DockerSandboxRunner` (`packages/executors/src/docker-sandbox-runner.ts`) implements `SandboxRunner`
by shelling out to the `docker` CLI via `execa`, the same subprocess approach `BaseCliExecutor`
already uses for agent CLIs.

- `create()` runs `docker create` + `docker start` with `--user`, `--read-only`, `--cap-drop=ALL`,
  `--security-opt=no-new-privileges`, `--pids-limit`, `--memory`/`--memory-swap`, `--cpus`, and
  `--network=none|bridge` (from `SandboxSpec.network.mode`). It never passes `--privileged`.
- The workspace and `/tmp` are `--tmpfs` mounts, not host bind mounts. Because the root filesystem
  is read-only, there is no container writable layer left to quota separately — every writable byte
  is one of these two size-capped tmpfs mounts. This is also why the disk ceiling
  (`SandboxSpec.resources.diskMiB`) is applied as the workspace tmpfs's `size=` rather than via
  `--storage-opt size=`: that flag only works on overlay2-over-xfs-with-pquota, which errors on this
  project's development machine and is not guaranteed on `ubuntu-latest` GitHub runners either
  (verified by hand before writing this ADR).
- `create()` rejects (before any Docker call) an image not pinned by digest (`@sha256:` must appear
  in `SandboxSpec.image`), and rejects any mount whose source or target references `docker.sock`, or
  whose target collides with the reserved `/workspace` or `/tmp` paths.
- `exec()` runs `docker exec -w /workspace <id> <command> <args...>` (no shell interpolation),
  streaming stdout/stderr chunks, honoring `timeoutMs` (throws on timeout), and honoring
  `AbortSignal` by throwing the same `RunCancelledError` used elsewhere in this codebase.
- `snapshot()` cannot use `docker cp`: verified by hand that `docker cp` fails to read a path mounted
  via `--tmpfs` on this Docker Desktop install (`Could not find the file`), even though the file is
  reachable via `docker exec ... cat`. Instead, `snapshot()` runs
  `docker exec <id> tar -cf - -C /workspace <path>` and pipes the tar stream into a host `tar -xf -`
  process, then reads the extracted files from a temp directory. A path that doesn't exist inside the
  sandbox is silently skipped (matches `SandboxRunner.snapshot`'s existing filtered-allowlist
  contract in `runSandboxLifecycle`).
- `destroy()` runs `docker rm -f`, tolerating "No such container" so repeated calls are safe, per the
  `SandboxRunner` interface's documented idempotency requirement.

Pinned base image for this ADR: `node@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`
(resolved from `node:22-bookworm-slim`, 2026-07-20). An SBOM for this exact digest is generated on
every CI run by the `sandbox-sbom` job and archived at `docs/sbom/sandbox-image.spdx.json`.

## Scope boundary

This ADR does **not** wire `DockerSandboxRunner` into `packages/composition`'s runtime graph or the
orchestrator's `ExecutionPlane`. Nothing in the codebase constructs a `SandboxSpec` today —
`LocalExecutionPlane` remains the active execution path. Adding composition-level config (e.g. a
`SANDBOX_IMAGE` env var) now, with no caller to consume it, would be speculative. Making this backend
the default execution path is explicitly sequenced after `v07-network-policy` (egress allowlisting —
today `network.mode: 'allowlist'` only selects the bridge network, with no proxy/DNS enforcement yet)
and `v07-secret-broker` (scoped, revocable credentials) in the roadmap. Switching the default before
those land would give agents unrestricted container egress and no secret-lifetime control, which is
not an improvement over the documented `LocalExecutionPlane` posture in `docs/SECURITY.md`.

## Consequences

`SandboxRunner` now has a real, tested implementation satisfying issue #47's acceptance criteria.
`packages/composition` and the orchestrator are unchanged; `docs/SECURITY.md`'s "Isolamento de
processo" section is updated to reflect that the backend exists but is not yet the default.

## Validation and rollback

```bash
npx vitest run packages/executors/src/docker-sandbox-runner.test.ts
npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts
```
````

The integration suite requires a running Docker daemon; it is `describe.skipIf`-gated so `npm test`
still passes without one. `ubuntu-latest` GitHub Actions runners have Docker Engine preinstalled, so
CI exercises it for real. Roll back with a revert; `DockerSandboxRunner` is dead code with respect to
production behavior until a future issue wires it in, so reverting changes nothing currently running.

```

- [ ] **Step 4: Update `docs/SECURITY.md`**

In `docs/SECURITY.md`, replace the paragraph at line 39 (in the "### Isolamento de processo" section):

Old:
```

O worker real roda com as permissões do usuário do host. Um comando permitido pela CLI pode alcançar tudo que esse usuário alcança. O sandbox do fornecedor ajuda, mas não substitui uma fronteira operacional independente. A ADR 0023 introduz a port `ExecutionPlane`, e a ADR 0024 define o contrato de ciclo de vida `SandboxRunner`; nenhum backend está conectado ainda, então as CLIs continuam rodando com as permissões do host até #47 fornecer isolamento rootless.

```

New:
```

O worker real roda com as permissões do usuário do host. Um comando permitido pela CLI pode alcançar tudo que esse usuário alcança. O sandbox do fornecedor ajuda, mas não substitui uma fronteira operacional independente. A ADR 0023 introduz a port `ExecutionPlane`, a ADR 0024 define o contrato de ciclo de vida `SandboxRunner`, e a ADR 0025 entrega `DockerSandboxRunner` — um backend rootless real (usuário não-root, sem privileged, capabilities zeradas, rootfs read-only, limites de CPU/memória/pids/disco aplicados). Nenhum caminho de execução hoje constrói um `SandboxSpec`; `LocalExecutionPlane` continua sendo o caminho ativo até a política de rede (`v07-network-policy`) e o secret broker (`v07-secret-broker`) permitirem trocar o padrão com segurança.

```

- [ ] **Step 5: Update `docs/ARCHITECTURE.md`**

In `docs/ARCHITECTURE.md`, replace lines 97-99:

Old:
```

fronteira de confiança em relação ao `ExecutorRegistry` direto de antes. `SandboxRunner` é o contrato
do próximo runner, mas nenhum backend está conectado ainda. No diagrama de sequência abaixo, o
participante `E` (Executor) agora é alcançado através dessa port.

```

New:
```

fronteira de confiança em relação ao `ExecutorRegistry` direto de antes. `SandboxRunner` é o contrato
do próximo runner; `DockerSandboxRunner` (ADR-0025, `packages/executors`) é sua primeira
implementação real, mas nenhum caminho de execução a conecta ainda — isso chega com a política de
rede e o secret broker. No diagrama de sequência abaixo, o participante `E` (Executor) agora é
alcançado através dessa port.

````

- [ ] **Step 6: Run the full local check suite**

Run: `npm run check`
Expected: PASS — `format:check`, `lint`, `architecture:check`, `roadmap:check`, `typecheck`, `test` (unit + scripts), `build` all succeed.

- [ ] **Step 7: Commit**

```bash
git add docs/sbom/sandbox-image.spdx.json .github/workflows/ci.yml docs/adr/0025-docker-sandbox-runner.md docs/SECURITY.md docs/ARCHITECTURE.md
git commit -m "docs: add ADR-0025, SBOM evidence, and CI job for the Docker sandbox runner"
````

---

## Self-Review Notes

- **Spec coverage:** non-root user (Task 3), no privileged + minimal capabilities (Tasks 1, 3), read-only rootfs except workspace/tmpfs (Tasks 1, 3), CPU/memory/pids/disk limits (Tasks 1, 2), digest pin + SBOM (Tasks 1, 6), Docker socket never mounted (Task 1), required tests for limits/user/mounts/host-access (Task 3) — all covered.
- **Placeholder scan:** none found — every step has runnable code or an exact command.
- **Type consistency:** `SandboxHandle`, `SandboxExecRequest`, `SandboxExecResult`, `SandboxSnapshot`, `SandboxSnapshotFile`, `SandboxRunner` are used with the exact names/shapes already defined in `packages/domain/src/sandbox-runner.ts` and `packages/contracts/src/sandbox.ts` (read directly from source before writing this plan, not assumed).
