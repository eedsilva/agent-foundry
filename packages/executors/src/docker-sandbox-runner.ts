import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { execa } from 'execa';
import type { SandboxSnapshot, SandboxSnapshotFile, SandboxSpec } from '@agent-foundry/contracts';
import type { SandboxHandle, SandboxRunner } from '@agent-foundry/domain';
import {
  ExecutionError,
  RunCancelledError,
  ValidationError,
  errorMessage,
  type SandboxExecRequest,
  type SandboxExecResult,
} from '@agent-foundry/domain';
import { terminateProcessTree } from './process-tree.js';

export const SANDBOX_WORKSPACE_PATH = '/workspace';
export const SANDBOX_TMP_SIZE_MIB = 64;

const RESERVED_MOUNT_TARGETS = new Set([SANDBOX_WORKSPACE_PATH, '/tmp']);

// Mounting one of these wholesale would expose the host Docker socket (or other
// sensitive host state) without the mount's source/target literally containing
// "docker.sock" — e.g. mounting /var/run instead of /var/run/docker.sock.
const SENSITIVE_MOUNT_ROOTS = new Set(['/', '/var/run', '/run', '/proc', '/sys', '/dev', '/etc']);

function assertDigestPinned(spec: SandboxSpec): void {
  if (!spec.image.includes('@sha256:')) {
    throw new ValidationError(`Sandbox image must be pinned by digest (got "${spec.image}").`);
  }
}

function assertMountsAreSafe(spec: SandboxSpec): void {
  for (const mount of spec.mounts) {
    if (mount.source.includes('docker.sock') || mount.target.includes('docker.sock')) {
      throw new ValidationError('Sandbox mounts must never reference the host Docker socket.');
    }
    if (SENSITIVE_MOUNT_ROOTS.has(mount.source) || SENSITIVE_MOUNT_ROOTS.has(mount.target)) {
      throw new ValidationError(
        `Sandbox mount "${mount.source}" -> "${mount.target}" is too broad; mount a specific subpath instead of a whole system directory.`,
      );
    }
    if (RESERVED_MOUNT_TARGETS.has(mount.target)) {
      throw new ValidationError(
        `Sandbox mount target "${mount.target}" is reserved for the runner's own tmpfs.`,
      );
    }
  }
}

function dockerFailure(
  action: string,
  result: { exitCode?: number; stdout?: string; stderr?: string },
): ExecutionError {
  return new ExecutionError(`${action} failed: ${result.stderr || result.stdout}`, {
    ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
    ...(result.stderr !== undefined ? { stderr: result.stderr } : {}),
  });
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
    `--pids-limit=${spec.resources.pids}`,
    `--memory=${spec.resources.memoryMiB}m`,
    `--memory-swap=${spec.resources.memoryMiB}m`,
    `--cpus=${(spec.resources.cpuMillis / 1000).toFixed(3)}`,
    `--network=${spec.network.mode === 'none' ? 'none' : 'bridge'}`,
    `--tmpfs=${SANDBOX_WORKSPACE_PATH}:rw,nosuid,nodev,size=${spec.resources.diskMiB}m,mode=1777`,
    `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${SANDBOX_TMP_SIZE_MIB}m,mode=1777`,
  ];
  for (const mount of spec.mounts) {
    args.push('-v', `${mount.source}:${mount.target}${mount.readOnly ? ':ro' : ''}`);
  }
  // A bounded keep-alive, not `sleep infinity`: if the control plane crashes between
  // create() and destroy(), the container self-reaps at its own TTL instead of running
  // forever as an orphan.
  args.push(spec.image, 'sleep', String(Math.ceil(spec.ttlMs / 1000)));
  return args;
}

export class DockerSandboxRunner implements SandboxRunner {
  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const args = buildCreateArgs(spec);
    const created = await execa('docker', args, { reject: false });
    if (created.exitCode !== 0) {
      throw dockerFailure('docker create', created);
    }
    const id = created.stdout.trim();
    const started = await execa('docker', ['start', id], { reject: false });
    if (started.exitCode !== 0) {
      await execa('docker', ['rm', '-f', id], { reject: false });
      throw dockerFailure('docker start', started);
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
      {
        timeout: request.timeoutMs,
        reject: false,
        all: false,
        encoding: 'utf8',
        // Own process group on POSIX so an abort/timeout kill reaches the whole
        // docker-exec client tree, matching BaseCliExecutor's convention.
        detached: process.platform !== 'win32',
      },
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
      onAbort = () => {
        void terminateProcessTree(subprocess);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const result = await subprocess;
      if (signal?.aborted) throw new RunCancelledError();
      if (result.timedOut) {
        throw new ExecutionError(`Sandbox exec exceeded its ${request.timeoutMs}ms timeout.`, {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        });
      }
      return {
        exitCode: result.exitCode ?? -1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    } catch (error) {
      if (signal?.aborted) throw new RunCancelledError();
      if (error instanceof Error) throw error;
      throw new ExecutionError(errorMessage(error));
    } finally {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async snapshot(
    sandbox: SandboxHandle,
    allowedPaths: readonly string[],
  ): Promise<SandboxSnapshot> {
    const tempDir = await mkdtemp(join(tmpdir(), 'agent-foundry-sandbox-'));
    try {
      // Each allowed path is an independent export from the sandbox into a distinct
      // subtree of tempDir, so they run concurrently rather than one at a time.
      await Promise.all(
        allowedPaths.map(async (relativePath) => {
          const tarResult = await execa(
            'docker',
            ['exec', sandbox.id, 'tar', '-cf', '-', '-C', SANDBOX_WORKSPACE_PATH, relativePath],
            { reject: false, encoding: 'buffer' },
          );
          if (tarResult.exitCode !== 0) return; // path does not exist in the sandbox — nothing to export
          await execa('tar', ['-xf', '-', '-C', tempDir], {
            input: tarResult.stdout,
            reject: false,
          });
        }),
      );
      return { files: await collectFiles(tempDir, tempDir) };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async destroy(sandbox: SandboxHandle): Promise<void> {
    const result = await execa('docker', ['rm', '-f', sandbox.id], { reject: false });
    if (result.exitCode !== 0 && !/No such container/.test(result.stderr ?? '')) {
      throw dockerFailure('docker rm', result);
    }
  }
}

async function collectFiles(root: string, dir: string): Promise<SandboxSnapshotFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<SandboxSnapshotFile[]> => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return collectFiles(root, fullPath);
      if (!entry.isFile()) return [];
      const content = await readFile(fullPath);
      return [
        { path: relative(root, fullPath).split(sep).join('/'), content: new Uint8Array(content) },
      ];
    }),
  );
  return files.flat();
}
