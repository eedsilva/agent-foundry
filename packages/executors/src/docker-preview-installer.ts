import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SandboxExec, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxRunner } from '@agent-foundry/domain';
import { DEFAULT_SANDBOX_NODE_IMAGE, SANDBOX_WORKSPACE_PATH } from './docker-sandbox-runner.js';
import type { PreviewInstaller, PreviewInstallOutcome } from './preview-command-plan.js';

export interface DockerPreviewInstallerOptions {
  runner: SandboxRunner;
  image?: string;
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
  private readonly runner: SandboxRunner;
  private readonly image: string;
  private readonly timeoutMs: number;

  constructor(options: DockerPreviewInstallerOptions) {
    this.runner = options.runner;
    this.image = options.image ?? DEFAULT_SANDBOX_NODE_IMAGE;
    // Installs run cold (no store mount); 120s killed 3 of 4 real preflights
    // (#422). 300s holds on a loaded host until a persistent pnpm store makes
    // cold installs warm.
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async install(input: Parameters<PreviewInstaller['install']>[0]): Promise<PreviewInstallOutcome> {
    if (!input.plan.install.ok) {
      return { ok: false, exitCode: 1, stdout: '', stderr: input.plan.install.reason };
    }
    const spec: SandboxSpec = {
      image: this.image,
      // Generated workspaces install Next/sharp/native optional packages in a
      // single sandbox. 2 GiB is not enough for pnpm's package-link phase, and
      // 1 CPU + 512 MiB scratch left a serialized cold install racing the
      // timeout (#422: exit 137 kills on real preflights).
      resources: { cpuMillis: 2_000, memoryMiB: 3_072, diskMiB: 1_024, pids: 128 },
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
    const installArgs = install.args;
    const originalManifest =
      install.command === 'pnpm'
        ? await configurePnpmForHostPreview(input.workspacePath)
        : undefined;
    const exec: SandboxExec = {
      command: 'env',
      args: [
        `HOME=${SANDBOX_WORKSPACE_PATH}`,
        ...(viaCorepack
          ? ['COREPACK_ENABLE_DOWNLOAD_PROMPT=0', 'CI=true', 'corepack', install.command]
          : ['CI=true', install.command]),
        ...installArgs,
      ],
      timeoutMs: this.timeoutMs,
      cwd: '/project',
    };
    try {
      const sandbox = await this.runner.create(spec);
      try {
        let result: Awaited<ReturnType<SandboxRunner['exec']>>;
        try {
          result = await this.runner.exec(sandbox, exec, input.signal);
        } catch (error) {
          if (input.signal?.aborted) throw error;
          return {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error),
          };
        }
        return {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
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
