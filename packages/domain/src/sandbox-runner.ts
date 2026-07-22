import { posix as path } from 'node:path';
import {
  SandboxSnapshotPathSchema,
  type SandboxExec,
  type SandboxSnapshot,
  type SandboxSpec,
} from '@agent-foundry/contracts';

export interface SandboxHandle {
  id: string;
}

export interface SandboxOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SandboxExecRequest extends SandboxExec {
  onOutput?: (chunk: SandboxOutputChunk) => void;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(
    sandbox: SandboxHandle,
    request: SandboxExecRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecResult>;
  snapshot(sandbox: SandboxHandle, allowedPaths: readonly string[]): Promise<SandboxSnapshot>;
  /** Must be safe to call repeatedly for the same handle. */
  destroy(sandbox: SandboxHandle): Promise<void>;
}

export async function runSandboxLifecycle(
  runner: SandboxRunner,
  spec: SandboxSpec,
  exec: SandboxExecRequest,
  allowedPaths: readonly string[],
  signal?: AbortSignal,
): Promise<{ result: SandboxExecResult; snapshot: SandboxSnapshot }> {
  const allowed = allowedPaths.map((entry) => SandboxSnapshotPathSchema.parse(entry));
  const sandbox = await runner.create(spec);
  try {
    const result = await runner.exec(sandbox, exec, signal);
    const snapshot = await runner.snapshot(sandbox, [...allowed]);
    return {
      result,
      snapshot: {
        files: snapshot.files.filter((file) =>
          allowed.some((entry) => isAllowed(file.path, entry)),
        ),
      },
    };
  } finally {
    try {
      await runner.destroy(sandbox);
    } catch (error) {
      console.error('Failed to destroy sandbox', error);
    }
  }
}

function isAllowed(filePath: string, allowedPath: string): boolean {
  const relative = path.relative(allowedPath, filePath);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  );
}
