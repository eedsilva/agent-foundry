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
  let settled = false;
  void Promise.resolve(subprocess).then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  killProcessTree(subprocess, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (processTreeAlive(subprocess, settled) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  if (processTreeAlive(subprocess, settled)) killProcessTree(subprocess, 'SIGKILL');
}

function processTreeAlive(subprocess: ProcessTree, settled: boolean): boolean {
  if (subprocess.pid === undefined || process.platform === 'win32') return !settled;
  try {
    process.kill(-subprocess.pid, 0);
    return true;
  } catch {
    return false;
  }
}
