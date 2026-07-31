import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NetworkPolicyEvent, SandboxExec, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import { DEFAULT_POLICY_PROXY_IMAGE, SANDBOX_WORKSPACE_PATH } from './docker-sandbox-runner.js';
import type { PreviewInstaller, PreviewInstallOutcome } from './preview-command-plan.js';

export interface NetworkPolicySandboxRunner extends SandboxRunner {
  networkEvidence(sandbox: SandboxHandle): Promise<{ events: NetworkPolicyEvent[] }>;
}

export interface DockerPreviewInstallerOptions {
  runner: NetworkPolicySandboxRunner;
  image?: string;
  allowedHosts?: string[];
  timeoutMs?: number;
}

async function configurePnpmForHostPreview(workspacePath: string): Promise<Buffer> {
  const manifestPath = join(workspacePath, 'package.json');
  const original = await readFile(manifestPath);
  const manifest = JSON.parse(original.toString()) as Record<string, unknown>;
  const pnpm = isRecord(manifest.pnpm) ? manifest.pnpm : {};
  const supportedArchitectures = isRecord(pnpm.supportedArchitectures)
    ? pnpm.supportedArchitectures
    : {};
  manifest.pnpm = {
    ...pnpm,
    supportedArchitectures: {
      ...supportedArchitectures,
      os: [process.platform],
      cpu: [process.arch],
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return original;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class DockerPreviewInstaller implements PreviewInstaller {
  private readonly runner: NetworkPolicySandboxRunner;
  private readonly image: string;
  private readonly allowedHosts: string[];
  private readonly timeoutMs: number;

  constructor(options: DockerPreviewInstallerOptions) {
    this.runner = options.runner;
    this.image = options.image ?? DEFAULT_POLICY_PROXY_IMAGE;
    this.allowedHosts = options.allowedHosts ?? ['registry.npmjs.org'];
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async install(input: Parameters<PreviewInstaller['install']>[0]): Promise<PreviewInstallOutcome> {
    if (!input.plan.install.ok) {
      return { ok: false, exitCode: 1, stdout: '', stderr: input.plan.install.reason };
    }
    const spec: SandboxSpec = {
      image: this.image,
      resources: { cpuMillis: 1_000, memoryMiB: 2_048, diskMiB: 512, pids: 128 },
      network: {
        mode: 'allowlist',
        allowedHosts: this.allowedHosts,
        purpose: 'dependency-install',
      },
      mounts: [{ source: input.workspacePath, target: '/project', readOnly: false }],
      ttlMs: this.timeoutMs + 30_000,
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    };
    // The pinned node image ships corepack but not pnpm or yarn; corepack
    // runs the exact version the workspace's `packageManager` field pins.
    // env(1) hands it a writable HOME — the container's rootfs is read-only
    // and its --user has no home directory.
    const install = input.plan.install;
    const viaCorepack = install.command === 'pnpm' || install.command === 'yarn';
    const originalManifest =
      install.command === 'pnpm'
        ? await configurePnpmForHostPreview(input.workspacePath)
        : undefined;
    const exec: SandboxExec = viaCorepack
      ? {
          command: 'env',
          args: [
            `HOME=${SANDBOX_WORKSPACE_PATH}`,
            'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
            'CI=true',
            'corepack',
            install.command,
            ...install.args,
          ],
          timeoutMs: this.timeoutMs,
          cwd: '/project',
        }
      : {
          command: install.command,
          args: install.args,
          timeoutMs: this.timeoutMs,
          cwd: '/project',
        };
    try {
      const sandbox = await this.runner.create(spec);
      try {
        let result: Awaited<ReturnType<NetworkPolicySandboxRunner['exec']>>;
        try {
          result = await this.runner.exec(sandbox, exec, input.signal);
        } catch (error) {
          const evidence = await this.runner
            .networkEvidence(sandbox)
            .catch(() => ({ events: [] as NetworkPolicyEvent[] }));
          if (input.signal?.aborted) throw error;
          return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
            networkEvents: evidence.events,
          };
        }
        let evidence: Awaited<ReturnType<NetworkPolicySandboxRunner['networkEvidence']>>;
        try {
          evidence = await this.runner.networkEvidence(sandbox);
        } catch (error) {
          return {
            ok: false,
            exitCode: result.exitCode === 0 ? -1 : result.exitCode,
            stdout: result.stdout,
            stderr: [
              result.stderr,
              `Network evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
            ]
              .filter(Boolean)
              .join('\n'),
            networkEvents: [],
          };
        }
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          networkEvents: evidence.events,
        };
      } finally {
        await this.runner.destroy(sandbox);
      }
    } finally {
      if (originalManifest) {
        await writeFile(join(input.workspacePath, 'package.json'), originalManifest);
      }
    }
  }
}
