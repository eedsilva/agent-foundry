import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import { runSandboxLifecycle, type SandboxHandle } from '@agent-foundry/domain';
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
    network: { mode: 'none', allowedHosts: [], purpose: 'execution' },
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
    const created: SandboxHandle[] = [];

    async function createTracked(overrides?: Partial<SandboxSpec>): Promise<SandboxHandle> {
      const handle = await runner.create(spec(overrides));
      created.push(handle);
      return handle;
    }

    afterEach(async () => {
      while (created.length > 0) {
        const handle = created.pop();
        if (handle) await runner.destroy(handle);
      }
    });

    it('creates a running container matching the hardening flags', async () => {
      const handle = await createTracked();

      const inspect = await execa('docker', ['inspect', handle.id, '--format', '{{json .}}']);
      const { State, HostConfig } = JSON.parse(inspect.stdout) as {
        State: { Running: boolean };
        HostConfig: {
          Memory: number;
          NanoCpus: number;
          PidsLimit: number;
          NetworkMode: string;
          ReadonlyRootfs: boolean;
          Privileged: boolean;
          CapDrop: string[];
          Tmpfs: Record<string, string>;
        };
      };
      expect(State.Running).toBe(true);
      expect(HostConfig).toMatchObject({
        Memory: 134217728,
        NanoCpus: 500000000,
        PidsLimit: 32,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        Tmpfs: {
          [SANDBOX_WORKSPACE_PATH]: 'rw,nosuid,nodev,size=64m,mode=1777',
          '/tmp': 'rw,nosuid,nodev,noexec,size=64m,mode=1777',
        },
      });

      await runner.destroy(handle);
      created.pop();
    });

    it('destroy is idempotent for the same handle', async () => {
      const handle = await createTracked();
      await runner.destroy(handle);
      await expect(runner.destroy(handle)).resolves.toBeUndefined();
    });

    it('rejects a spec with an unpinned image before touching Docker', async () => {
      await expect(runner.create(spec({ image: 'node:22-bookworm-slim' }))).rejects.toThrow(
        /pinned by digest/,
      );
    });

    it('runs as the configured non-root user', async () => {
      const handle = await createTracked({ user: '1000:1000' });
      const result = await runner.exec(handle, { command: 'id', args: ['-u'], timeoutMs: 5_000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('1000');
    });

    it('has an all-zero effective capability set', async () => {
      const handle = await createTracked();
      const result = await runner.exec(handle, {
        command: 'sh',
        args: ['-c', 'grep CapEff /proc/self/status'],
        timeoutMs: 5_000,
      });
      expect(result.stdout.trim()).toBe('CapEff:\t0000000000000000');
    });

    it('rejects writes outside the workspace and tmp on the read-only rootfs', async () => {
      const handle = await createTracked();
      const result = await runner.exec(handle, {
        command: 'sh',
        args: ['-c', 'touch /etc/should-fail'],
        timeoutMs: 5_000,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system/);
    });

    it('allows writes inside the workspace tmpfs', async () => {
      const handle = await createTracked();
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
      const handle = await createTracked({
        resources: { cpuMillis: 500, memoryMiB: 128, diskMiB: 64, pids: 4 },
      });
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
      const handle = await createTracked({
        network: { mode: 'none', allowedHosts: [], purpose: 'execution' },
      });
      const result = await runner.exec(handle, {
        command: 'sh',
        args: ['-c', 'cat /proc/net/route | wc -l'],
        timeoutMs: 5_000,
      });
      expect(result.stdout.trim()).toBe('1'); // header row only, no routes
    });

    it('enforces allowlisted DNS and HTTP while blocking raw, forbidden, and metadata egress', async () => {
      const handle = await createTracked({
        network: {
          mode: 'allowlist',
          allowedHosts: ['example.com'],
          purpose: 'execution',
        },
      });
      const inspect = await execa('docker', [
        'inspect',
        handle.id,
        '--format',
        '{{.HostConfig.NetworkMode}}',
      ]);
      expect(inspect.stdout.trim()).toMatch(/^agent-foundry-policy-/);
      expect(inspect.stdout.trim()).not.toBe('bridge');

      const raw = await runner.exec(handle, {
        command: 'node',
        args: [
          '-e',
          "const s=require('net').connect(80,'1.1.1.1',()=>process.exit(2));s.setTimeout(1000,()=>process.exit(0));s.on('error',()=>process.exit(0))",
        ],
        timeoutMs: 3_000,
      });
      expect(raw.exitCode).toBe(0);

      const allowedDns = await runner.exec(handle, {
        command: 'node',
        args: [
          '-e',
          "require('dns').lookup('example.com',(error,address)=>{if(error)throw error;console.log(address)})",
        ],
        timeoutMs: 5_000,
      });
      expect(allowedDns.exitCode).toBe(0);

      const forbiddenDns = await runner.exec(handle, {
        command: 'node',
        args: ['-e', "require('dns').lookup('google.com',(error)=>process.exit(error?0:2))"],
        timeoutMs: 5_000,
      });
      expect(forbiddenDns.exitCode).toBe(0);

      const proxied = await runner.exec(handle, {
        command: 'node',
        args: [
          '-e',
          "const p=new URL(process.env.HTTP_PROXY);require('http').get({host:p.hostname,port:p.port,path:'http://example.com/',headers:{host:'example.com'}},r=>{console.log(r.statusCode);r.resume();r.on('end',()=>process.exit(r.statusCode<500?0:2))}).on('error',()=>process.exit(3))",
        ],
        timeoutMs: 10_000,
      });
      expect(proxied.exitCode).toBe(0);

      const metadata = await runner.exec(handle, {
        command: 'node',
        args: [
          '-e',
          "const p=new URL(process.env.HTTP_PROXY);require('http').get({host:p.hostname,port:p.port,path:'http://169.254.169.254/latest/meta-data',headers:{host:'169.254.169.254'}},r=>{console.log(r.statusCode);r.resume();r.on('end',()=>process.exit(r.statusCode===403?0:2))}).on('error',()=>process.exit(3))",
        ],
        timeoutMs: 5_000,
      });
      expect(metadata.exitCode).toBe(0);

      const evidence = await runner.networkEvidence(handle);
      expect(evidence.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ protocol: 'dns', decision: 'allow', hostname: 'example.com' }),
          expect.objectContaining({ protocol: 'dns', decision: 'deny', hostname: 'google.com' }),
          expect.objectContaining({ protocol: 'http', decision: 'allow', hostname: 'example.com' }),
          expect.objectContaining({
            protocol: 'http',
            decision: 'deny',
            hostname: '169.254.169.254',
          }),
        ]),
      );
    });

    it('honors a read-only bind mount', async () => {
      const hostDir = await mkdtemp(join(tmpdir(), 'sandbox-mount-'));
      // mkdtemp defaults to 0700 (owner-only). The sandbox container runs as a fixed
      // uid (1000:1000 in this test), which on a real Linux bind mount (unlike Docker
      // Desktop's virtualized filesystem) can't even traverse a directory it doesn't
      // own unless it's group/other-executable.
      await chmod(hostDir, 0o755);
      await writeFile(join(hostDir, 'seed.txt'), 'seed');

      const handle = await createTracked({
        mounts: [{ source: hostDir, target: '/mnt/cache', readOnly: true }],
      });

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
      const handle = await createTracked();
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
      const handle = await createTracked();
      await expect(
        runner.exec(handle, { command: 'sleep', args: ['5'], timeoutMs: 300 }),
      ).rejects.toThrow(/timeout/);
    });

    it('throws RunCancelledError when the signal is already aborted', async () => {
      const handle = await createTracked();
      const controller = new AbortController();
      controller.abort();
      await expect(
        runner.exec(handle, { command: 'sleep', args: ['1'], timeoutMs: 5_000 }, controller.signal),
      ).rejects.toThrow(/cancelled/);
    });

    it('throws RunCancelledError when aborted mid-execution', async () => {
      const handle = await createTracked();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      await expect(
        runner.exec(
          handle,
          { command: 'sleep', args: ['5'], timeoutMs: 10_000 },
          controller.signal,
        ),
      ).rejects.toThrow(/cancelled/);
    });

    it('extracts allowed files and directories from the workspace', async () => {
      const handle = await createTracked();
      await runner.exec(handle, {
        command: 'sh',
        args: ['-c', 'echo hello > out.txt && mkdir sub && echo nested > sub/n.txt'],
        timeoutMs: 5_000,
      });

      const snapshot = await runner.snapshot(handle, ['out.txt', 'sub']);
      const byPath = Object.fromEntries(
        snapshot.files.map((file) => [
          file.path,
          Buffer.from(file.content).toString('utf8').trim(),
        ]),
      );
      expect(byPath['out.txt']).toBe('hello');
      expect(byPath['sub/n.txt']).toBe('nested');
    });

    it('silently skips an allowed path that does not exist', async () => {
      const handle = await createTracked();
      const snapshot = await runner.snapshot(handle, ['does-not-exist']);
      expect(snapshot.files).toEqual([]);
    });

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
  },
  60_000,
);
