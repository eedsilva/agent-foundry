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
        args: ['-c', `echo hello > ${SANDBOX_WORKSPACE_PATH}/ok.txt && cat ${SANDBOX_WORKSPACE_PATH}/ok.txt`],
        timeoutMs: 5_000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('enforces the pids limit', async () => {
      const handle = await runner.create(spec({ resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 4 } }));
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
      const handle = await runner.create(spec({ network: { mode: 'allowlist', allowedHosts: ['example.com'] } }));
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

      const read = await runner.exec(handle, { command: 'cat', args: ['/mnt/cache/seed.txt'], timeoutMs: 5_000 });
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
  },
  60_000,
);
