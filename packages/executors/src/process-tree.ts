export interface ProcessTree extends PromiseLike<unknown> {
  pid?: number;
  kill?(signal?: NodeJS.Signals): boolean;
}

export function killProcessTree(subprocess: ProcessTree, signal: NodeJS.Signals): void {
  if (subprocess.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-subprocess.pid, signal);
      return;
    } catch {
      // Group already gone or the child is not a group leader; fall back to a direct kill.
    }
  }
  subprocess.kill?.(signal);
}

export async function terminateProcessTree(
  subprocess: ProcessTree,
  graceMs = 2_000,
): Promise<void> {
  killProcessTree(subprocess, 'SIGTERM');
  let graceTimer: NodeJS.Timeout | undefined;
  const exited = await Promise.race([
    Promise.resolve(subprocess).then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => {
      graceTimer = setTimeout(() => resolve(false), graceMs);
      graceTimer.unref?.();
    }),
  ]);
  if (graceTimer) clearTimeout(graceTimer);
  if (!exited) killProcessTree(subprocess, 'SIGKILL');
}
