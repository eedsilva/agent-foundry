import type { NetworkPolicyEvent, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import { DEFAULT_POLICY_PROXY_IMAGE } from './docker-sandbox-runner.js';
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
      resources: { cpuMillis: 1_000, memoryMiB: 1_024, diskMiB: 512, pids: 128 },
      network: {
        mode: 'allowlist',
        allowedHosts: this.allowedHosts,
        purpose: 'dependency-install',
      },
      mounts: [{ source: input.workspacePath, target: '/project', readOnly: false }],
      ttlMs: this.timeoutMs + 30_000,
      user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    };
    const sandbox = await this.runner.create(spec);
    try {
      let result: Awaited<ReturnType<NetworkPolicySandboxRunner['exec']>>;
      try {
        result = await this.runner.exec(
          sandbox,
          {
            command: input.plan.install.command,
            args: input.plan.install.args,
            timeoutMs: this.timeoutMs,
            cwd: '/project',
          },
          input.signal,
        );
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
          exitCode: -1,
          stdout: result.stdout,
          stderr: error instanceof Error ? error.message : String(error),
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
  }
}
