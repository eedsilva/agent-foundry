import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { NetworkPolicyEvent, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxExecRequest, SandboxHandle } from '@agent-foundry/domain';
import {
  DockerPreviewInstaller,
  type NetworkPolicySandboxRunner,
} from './docker-preview-installer.js';

const EVENT: NetworkPolicyEvent = {
  timestamp: '2026-07-22T12:00:00.000Z',
  purpose: 'dependency-install',
  protocol: 'connect',
  decision: 'allow',
  hostname: 'registry.npmjs.org',
  port: 443,
  addresses: ['104.16.0.35'],
  reason: 'allowlisted public destination',
};

function fakeRunner(exitCode = 0): NetworkPolicySandboxRunner & {
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
    networkEvidence: async () => ({ events: [EVENT] }),
  };
}

describe('DockerPreviewInstaller', () => {
  it('runs npm ci in a dependency-install sandbox and records policy evidence', async () => {
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
      network: {
        mode: 'allowlist',
        purpose: 'dependency-install',
        allowedHosts: ['registry.npmjs.org'],
      },
      mounts: [{ source: '/host/project', target: '/project', readOnly: false }],
    });
    expect(runner.requests[0]).toMatchObject({
      command: 'env',
      args: ['HOME=/workspace', 'CI=true', 'npm', 'ci'],
      cwd: '/project',
    });
    expect(outcome).toMatchObject({ ok: true, networkEvents: [EVENT] });
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
          '--child-concurrency=1',
          '--network-concurrency=1',
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

  it('returns a durable failed outcome with network evidence when execution throws', async () => {
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
      networkEvents: [EVENT],
    });
    expect(runner.destroy).toHaveBeenCalledOnce();
  });

  it('returns a failed outcome when mandatory network evidence cannot be read', async () => {
    const runner = fakeRunner();
    runner.networkEvidence = vi.fn(async () => {
      throw new Error('audit unavailable');
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
      stderr: 'Network evidence unavailable: audit unavailable',
      networkEvents: [],
    });
    expect(runner.destroy).toHaveBeenCalledOnce();
  });

  it('preserves the install error when execution and evidence collection both fail', async () => {
    const runner = fakeRunner();
    runner.exec = vi.fn(async () => {
      throw new Error('install timed out');
    });
    runner.networkEvidence = vi.fn(async () => {
      throw new Error('audit unavailable');
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
      networkEvents: [],
    });
    expect(runner.destroy).toHaveBeenCalledOnce();
  });
});
