import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxExecRequest, SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import { DockerPreviewInstaller } from './docker-preview-installer.js';

function fakeRunner(exitCode = 0): SandboxRunner & {
  specs: SandboxSpec[];
  requests: SandboxExecRequest[];
  destroy: ReturnType<typeof vi.fn<(sandbox: SandboxHandle) => Promise<void>>>;
} {
  const specs: SandboxSpec[] = [];
  const requests: SandboxExecRequest[] = [];
  const handle: SandboxHandle = { id: 'sandbox-1' };
  return {
    specs,
    requests,
    create: async (spec) => {
      specs.push(spec);
      return handle;
    },
    exec: async (_sandbox, request) => {
      requests.push(request);
      return { exitCode, stdout: 'installed', stderr: exitCode === 0 ? '' : 'failed' };
    },
    snapshot: async () => ({ files: [] }),
    destroy: vi.fn(async (_sandbox: SandboxHandle) => undefined),
  };
}

describe('DockerPreviewInstaller', () => {
  it('runs npm ci in an install sandbox', async () => {
    const runner = fakeRunner();
    const installer = new DockerPreviewInstaller({ runner });

    const outcome = await installer.install({
      plan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: false, reason: 'not needed' },
        dev: { ok: false, reason: 'not needed' },
        detectedAt: '2026-07-22T12:00:00.000Z',
      },
      workspacePath: '/host/project',
    });

    expect(runner.specs[0]).toMatchObject({
      resources: { memoryMiB: 3_072 },
      mounts: [{ source: '/host/project', target: '/project', readOnly: false }],
    });
    expect(runner.requests[0]).toMatchObject({
      command: 'env',
      args: ['HOME=/workspace', 'CI=true', 'npm', 'ci'],
      cwd: '/project',
    });
    expect(outcome).toMatchObject({ ok: true });
    expect(runner.destroy).toHaveBeenCalledWith({ id: 'sandbox-1' });
  });

  it('runs pnpm through corepack with host-only optional packages', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'agent-foundry-preview-'));
    const packagePath = join(workspacePath, 'package.json');
    const originalPackage = '{"name":"generated-app","pnpm":{"overrides":{"postcss":"^8"}}}\n';
    await writeFile(packagePath, originalPackage);
    const runner = fakeRunner();
    let installedManifest: Record<string, unknown> | undefined;
    runner.exec = async (_sandbox, request) => {
      runner.requests.push(request);
      installedManifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<
        string,
        unknown
      >;
      return { exitCode: 0, stdout: 'installed', stderr: '' };
    };
    const installer = new DockerPreviewInstaller({ runner });

    try {
      const outcome = await installer.install({
        plan: {
          packageManager: 'pnpm',
          install: { ok: true, command: 'pnpm', args: ['install', '--frozen-lockfile'] },
          build: { ok: false, reason: 'not needed' },
          dev: { ok: false, reason: 'not needed' },
          detectedAt: '2026-07-22T12:00:00.000Z',
        },
        workspacePath,
      });

      expect(runner.requests[0]).toMatchObject({
        command: 'env',
        args: [
          'HOME=/workspace',
          'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
          'CI=true',
          'corepack',
          'pnpm',
          'install',
          '--frozen-lockfile',
        ],
        cwd: '/project',
      });
      expect(installedManifest).toMatchObject({
        pnpm: {
          overrides: { postcss: '^8' },
          supportedArchitectures: { os: [process.platform], cpu: [process.arch] },
        },
      });
      expect(outcome).toMatchObject({ ok: true });
      expect(await readFile(packagePath, 'utf8')).toBe(originalPackage);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('destroys the sandbox when install execution fails', async () => {
    const runner = fakeRunner(1);
    const installer = new DockerPreviewInstaller({ runner });

    await installer.install({
      plan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: false, reason: 'not needed' },
        dev: { ok: false, reason: 'not needed' },
        detectedAt: '2026-07-22T12:00:00.000Z',
      },
      workspacePath: '/host/project',
    });

    expect(runner.destroy).toHaveBeenCalledOnce();
  });

  it('returns a durable failed outcome when execution throws', async () => {
    const runner = fakeRunner();
    runner.exec = vi.fn(async () => {
      throw new Error('install timed out');
    });
    const installer = new DockerPreviewInstaller({ runner });

    const outcome = await installer.install({
      plan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: false, reason: 'not needed' },
        dev: { ok: false, reason: 'not needed' },
        detectedAt: '2026-07-22T12:00:00.000Z',
      },
      workspacePath: '/host/project',
    });

    expect(outcome).toMatchObject({
      ok: false,
      exitCode: -1,
      stderr: 'install timed out',
      // The sandbox failed, not the install: nothing here says anything about
      // the generated app's dependencies (#659).
      infrastructure: true,
    });
    expect(runner.destroy).toHaveBeenCalledOnce();
  });

  it('marks an unreachable sandbox as infrastructure without destroying one (#659)', async () => {
    const runner = fakeRunner();
    runner.create = vi.fn(async () => {
      throw new Error('docker create failed: failed to connect to the docker API');
    });
    const installer = new DockerPreviewInstaller({ runner });

    const outcome = await installer.install({
      plan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: false, reason: 'not needed' },
        dev: { ok: false, reason: 'not needed' },
        detectedAt: '2026-07-22T12:00:00.000Z',
      },
      workspacePath: '/host/project',
    });

    // Before #659 this threw out of install(), and the caller had only the
    // message to go on.
    expect(outcome).toMatchObject({ ok: false, infrastructure: true });
    expect(outcome.stderr).toContain('failed to connect to the docker API');
    expect(runner.destroy).not.toHaveBeenCalled();
  });

  it('leaves an install the generated app broke unmarked (#659)', async () => {
    const runner = fakeRunner(1);
    const installer = new DockerPreviewInstaller({ runner });

    const outcome = await installer.install({
      plan: {
        packageManager: 'npm',
        install: { ok: true, command: 'npm', args: ['ci'] },
        build: { ok: false, reason: 'not needed' },
        dev: { ok: false, reason: 'not needed' },
        detectedAt: '2026-07-22T12:00:00.000Z',
      },
      workspacePath: '/host/project',
    });

    // The sandbox ran the install and it exited non-zero: that is a product
    // defect, and marking it infrastructure would hide it.
    expect(outcome).toMatchObject({ ok: false, exitCode: 1 });
    expect(outcome.infrastructure).toBeUndefined();
  });
});
