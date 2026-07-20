import { execa } from 'execa';
import type { SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';

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
