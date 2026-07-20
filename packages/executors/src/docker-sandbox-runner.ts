import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { execa } from 'execa';
import type { SandboxSnapshot, SandboxSnapshotFile, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import { RunCancelledError, errorMessage, type SandboxExecRequest, type SandboxExecResult } from '@agent-foundry/domain';

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

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const result = await execa('docker', ['rm', '-f', sandbox.id], { reject: false });
    if (result.exitCode !== 0 && !/No such container/.test(result.stderr ?? '')) {
      throw new Error(`docker rm failed: ${result.stderr || result.stdout}`);
    }
  }
}

async function collectFiles(root: string, dir: string): Promise<SandboxSnapshotFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SandboxSnapshotFile[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, fullPath)));
    } else if (entry.isFile()) {
      const content = await readFile(fullPath);
      files.push({ path: relative(root, fullPath).split(sep).join('/'), content: new Uint8Array(content) });
    }
  }
  return files;
}
